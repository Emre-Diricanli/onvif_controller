const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

export function createPlayer({ video, sessionId }) {
  if (!(video instanceof HTMLVideoElement)) throw new TypeError('video must be an HTMLVideoElement.');
  const listeners = new Map();
  let state = 'idle';
  let profileToken = null;
  let streamId = null;
  let streamInfo = null;
  let socket = null;
  let mediaSource = null;
  let sourceBuffer = null;
  let objectUrl = null;
  let snapshotImage = null;
  let snapshotTimer = null;
  let snapshotObjectUrl = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let generation = 0;
  let appendQueue = [];
  let retryBuffer = null;
  let destroyed = false;
  let stopping = false;

  function emit(event, ...args) {
    for (const cb of listeners.get(event) || []) {
      try { cb(...args); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  function setState(next, detail) {
    if (state === next && detail === undefined) return;
    state = next;
    video.dataset.playerState = next;
    emit('state', next, detail);
  }

  async function api(path, options = {}) {
    const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}${path}`, {
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
    });
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch { /* Non-JSON proxy error. */ }
      const error = new Error(detail?.message || `Request failed with HTTP ${response.status}.`);
      error.code = detail?.code || 'STREAM_FAILED';
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  function clearMedia() {
    appendQueue = [];
    retryBuffer = null;
    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onSourceError);
    }
    sourceBuffer = null;
    if (mediaSource?.readyState === 'open') {
      try { mediaSource.endOfStream(); } catch { /* Source may already be closing. */ }
    }
    mediaSource = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  function removeSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (snapshotObjectUrl) URL.revokeObjectURL(snapshotObjectUrl);
    snapshotObjectUrl = null;
    snapshotImage?.remove();
    snapshotImage = null;
    video.classList.remove('player-video--degraded');
  }

  async function pollSnapshot(myGeneration) {
    if (generation !== myGeneration || state !== 'degraded') return;
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/snapshot?profile=${encodeURIComponent(profileToken)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
      const blob = await response.blob();
      if (generation !== myGeneration) return;
      const nextUrl = URL.createObjectURL(blob);
      snapshotImage.src = nextUrl;
      const previous = snapshotObjectUrl;
      snapshotObjectUrl = nextUrl;
      if (previous) snapshotImage.addEventListener('load', () => URL.revokeObjectURL(previous), { once: true });
    } catch (error) {
      emit('error', { code: 'STREAM_FAILED', message: error.message });
    } finally {
      if (generation === myGeneration && state === 'degraded') snapshotTimer = setTimeout(() => pollSnapshot(myGeneration), 500);
    }
  }

  function degrade(detail) {
    if (destroyed || stopping) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    clearMedia();
    setState('degraded', detail);
    emit('degraded', detail);
    if (!snapshotImage) {
      snapshotImage = document.createElement('img');
      snapshotImage.className = 'player-snapshot';
      snapshotImage.alt = 'Live camera snapshots';
      snapshotImage.setAttribute('aria-live', 'off');
      const parent = video.parentElement;
      if (parent) {
        parent.classList.add('player-surface');
        parent.append(snapshotImage);
      } else {
        video.insertAdjacentElement('afterend', snapshotImage);
      }
    }
    video.classList.add('player-video--degraded');
    pollSnapshot(generation);
  }

  function evictOldBuffer() {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return false;
    const liveEdge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    const removeEnd = Math.min(liveEdge - 10, video.currentTime - 1);
    if (removeEnd > sourceBuffer.buffered.start(0)) {
      sourceBuffer.remove(sourceBuffer.buffered.start(0), removeEnd);
      return true;
    }
    return false;
  }

  function maintainLiveEdge() {
    if (!sourceBuffer?.buffered.length) return;
    const liveEdge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
    if (Number.isFinite(liveEdge) && liveEdge - video.currentTime > 1.5) video.currentTime = Math.max(0, liveEdge - 0.35);
    evictOldBuffer();
  }

  function pump() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const next = retryBuffer || appendQueue.shift();
    if (!next) {
      maintainLiveEdge();
      return;
    }
    retryBuffer = null;
    try {
      sourceBuffer.appendBuffer(next);
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        retryBuffer = next;
        if (!evictOldBuffer()) setTimeout(pump, 100);
      } else {
        emit('error', { code: 'STREAM_FAILED', message: 'The browser could not decode the video stream.' });
        degrade({ reason: 'The browser could not decode the video stream.', fallback: 'snapshot' });
      }
    }
  }

  function onUpdateEnd() {
    maintainLiveEdge();
    pump();
    if (state !== 'playing' && video.readyState >= 2) setState('playing');
  }

  function onSourceError() {
    degrade({ reason: 'The browser rejected the video stream.', fallback: 'snapshot' });
  }

  function enqueue(data) {
    appendQueue.push(data);
    pump();
  }

  function prepareMediaSource(mime, myGeneration) {
    return new Promise((resolve, reject) => {
      mediaSource = new MediaSource();
      objectUrl = URL.createObjectURL(mediaSource);
      video.src = objectUrl;
      mediaSource.addEventListener('sourceopen', () => {
        if (generation !== myGeneration) return reject(new Error('Player start was superseded.'));
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mime);
          sourceBuffer.mode = 'segments';
          sourceBuffer.addEventListener('updateend', onUpdateEnd);
          sourceBuffer.addEventListener('error', onSourceError);
          video.play().catch(() => {});
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
    });
  }

  function connectSocket(myGeneration) {
    if (generation !== myGeneration || stopping || destroyed) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${location.host}/ws/stream?session=${encodeURIComponent(sessionId)}&stream=${encodeURIComponent(streamId)}`;
    socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { reconnectAttempt = 0; };
    socket.onmessage = ({ data }) => {
      if (generation !== myGeneration) return;
      if (typeof data !== 'string') {
        enqueue(new Uint8Array(data));
        return;
      }
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (frame.type === 'ready') return;
      if (frame.type === 'stats') {
        let latencyMs = null;
        if (sourceBuffer?.buffered.length) {
          const edge = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
          latencyMs = Math.max(0, Math.round((edge - video.currentTime) * 1000));
        }
        emit('stats', { bitrateKbps: frame.bitrateKbps, fps: frame.fps, droppedFrames: frame.droppedFrames, latencyMs });
      } else if (frame.type === 'degraded') {
        degrade({ reason: frame.reason, fallback: frame.fallback });
      } else if (frame.type === 'error') {
        emit('error', { code: frame.code, message: frame.message });
      }
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      socket = null;
      if (generation !== myGeneration || stopping || destroyed || state === 'degraded') return;
      if (event.code === 4001 || event.code === 4002) {
        const detail = { code: event.code === 4001 ? 'SESSION_EXPIRED' : 'STREAM_FAILED', message: event.reason || 'The stream was stopped.' };
        setState('error', detail);
        emit('error', detail);
        return;
      }
      setState('reconnecting');
      const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => restartConnection(myGeneration), delay);
    };
  }

  async function restartConnection(myGeneration) {
    if (generation !== myGeneration || stopping || destroyed) return;
    try {
      const nextInfo = await api('/stream/start', { method: 'POST', body: JSON.stringify({ profile: profileToken }) });
      if (generation !== myGeneration) {
        stopRemote(nextInfo.streamId);
        return;
      }
      streamInfo = nextInfo;
      streamId = nextInfo.streamId;
      if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(nextInfo.mime)) {
        stopRemote(streamId);
        streamId = null;
        degrade({ reason: 'This browser does not support the camera video format.', fallback: 'snapshot' });
        return;
      }
      clearMedia();
      await prepareMediaSource(nextInfo.mime, myGeneration);
      connectSocket(myGeneration);
    } catch (error) {
      if (generation !== myGeneration) return;
      emit('error', { code: error.code || 'STREAM_FAILED', message: error.message });
      const delay = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => restartConnection(myGeneration), delay);
    }
  }

  function stopRemote(id) {
    if (!id) return;
    fetch(`/api/session/${encodeURIComponent(sessionId)}/stream/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streamId: id }), keepalive: true,
    }).catch(() => {});
  }

  function stop() {
    generation += 1;
    stopping = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, 'Player stopped');
      socket = null;
    }
    const oldStreamId = streamId;
    streamId = null;
    stopRemote(oldStreamId);
    removeSnapshot();
    clearMedia();
    reconnectAttempt = 0;
    stopping = false;
    if (!destroyed) setState('idle');
  }

  async function start(nextProfileToken) {
    if (destroyed) throw new Error('The player has been destroyed.');
    stop();
    const myGeneration = generation;
    profileToken = nextProfileToken;
    setState('connecting');
    try {
      streamInfo = await api('/stream/start', { method: 'POST', body: JSON.stringify({ profile: profileToken }) });
      if (generation !== myGeneration) {
        stopRemote(streamInfo.streamId);
        return;
      }
      streamId = streamInfo.streamId;
      if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(streamInfo.mime)) {
        stopRemote(streamId);
        streamId = null;
        degrade({ reason: 'This browser does not support the camera video format.', fallback: 'snapshot' });
        return;
      }
      await prepareMediaSource(streamInfo.mime, myGeneration);
      connectSocket(myGeneration);
    } catch (error) {
      if (generation !== myGeneration) return;
      clearMedia();
      const detail = { code: error.code || 'STREAM_FAILED', message: error.message };
      setState('error', detail);
      emit('error', detail);
      throw error;
    }
  }

  function destroy() {
    if (destroyed) return;
    stop();
    destroyed = true;
    video.removeAttribute('data-player-state');
    listeners.clear();
  }

  function on(event, cb) {
    if (typeof cb !== 'function') throw new TypeError('Player event callback must be a function.');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(cb);
    return () => listeners.get(event)?.delete(cb);
  }

  video.classList.add('player-video');
  video.parentElement?.classList.add('player-surface');
  return { start, stop, destroy, on, getState: () => state };
}
