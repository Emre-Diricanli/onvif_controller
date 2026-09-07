const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

// /stream/start failure codes where only the transcode path failed and the
// camera itself is fine, so snapshot polling can still deliver a picture —
// the fallback the README and the server banner promise. Codes that incriminate
// the camera or the session (DEVICE_UNREACHABLE, DEVICE_TIMEOUT, UNAUTHORIZED,
// UNSUPPORTED, NOT_FOUND, SESSION_EXPIRED) are excluded on purpose: snapshots
// come from that same camera, so degrading would promise a fallback that
// cannot happen. Those keep the honest error screen.
const SNAPSHOT_FALLBACK_CODES = new Set(['FFMPEG_MISSING', 'STREAM_FAILED']);

/**
 * Calls handler(reason) whenever the page can no longer safely receive the end
 * of an in-progress pointer gesture. Returns a function that removes all hooks.
 */
export function onPageInactive(handler) {
  if (typeof handler !== 'function') throw new TypeError('Page-inactive handler must be a function.');
  const onVisibility = () => { if (document.visibilityState === 'hidden') handler('hidden'); };
  const onPageHide = () => handler('pagehide');
  const onBlur = () => handler('blur');
  const onPointerCancel = () => handler('pointercancel');
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointercancel', onPointerCancel);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('pointercancel', onPointerCancel);
  };
}

function isInitSegment(data) {
  return data.byteLength >= 8
    && String.fromCharCode(data[4], data[5], data[6], data[7]) === 'ftyp';
}

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
  let snapshotAbortController = null;
  let snapshotObjectUrl = null;
  let degradedBadge = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let generation = 0;
  let appendQueue = [];
  let retryBuffer = null;
  let currentAppend = null;
  let initSeen = false;
  let latestInitSegment = null;
  let mediaRebuildPromise = null;
  let latencyAnchor = null;
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
    currentAppend = null;
    latencyAnchor = null;
    if (sourceBuffer) {
      sourceBuffer.removeEventListener('updateend', onUpdateEnd);
      sourceBuffer.removeEventListener('error', onSourceError);
    }
    sourceBuffer = null;
    if (mediaSource) {
      mediaSource.removeEventListener('sourceended', onMediaSourceFailure);
      mediaSource.removeEventListener('error', onMediaSourceFailure);
    }
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
    snapshotAbortController?.abort();
    snapshotAbortController = null;
    if (snapshotObjectUrl) URL.revokeObjectURL(snapshotObjectUrl);
    snapshotObjectUrl = null;
    snapshotImage?.remove();
    snapshotImage = null;
    degradedBadge?.remove();
    degradedBadge = null;
    video.classList.remove('player-video--degraded');
  }

  async function pollSnapshot(myGeneration) {
    if (generation !== myGeneration || state !== 'degraded' || snapshotAbortController) return;
    const controller = new AbortController();
    snapshotAbortController = controller;
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/snapshot?profile=${encodeURIComponent(profileToken)}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Snapshot request failed with HTTP ${response.status}.`);
      const blob = await response.blob();
      if (generation !== myGeneration) return;
      const nextUrl = URL.createObjectURL(blob);
      snapshotImage.src = nextUrl;
      const previous = snapshotObjectUrl;
      snapshotObjectUrl = nextUrl;
      if (previous) snapshotImage.addEventListener('load', () => URL.revokeObjectURL(previous), { once: true });
    } catch (error) {
      if (error.name !== 'AbortError') emit('error', { code: 'STREAM_FAILED', message: error.message });
    } finally {
      if (snapshotAbortController === controller) snapshotAbortController = null;
      if (generation === myGeneration && state === 'degraded') snapshotTimer = setTimeout(() => pollSnapshot(myGeneration), 500);
    }
  }

  function degrade(detail) {
    if (destroyed || stopping) return;
    // Re-entry must not arm a second polling chain: pollSnapshot skips a tick
    // only while a fetch is in flight, so a duplicate degrade with the poll
    // timer merely pending would leave two timers respawning each other.
    if (state === 'degraded') return;
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
    if (!degradedBadge) {
      degradedBadge = document.createElement('div');
      degradedBadge.className = 'player-degraded-badge';
      degradedBadge.textContent = 'Live view unavailable — showing snapshots';
      degradedBadge.setAttribute('role', 'status');
      (video.parentElement || snapshotImage.parentElement)?.append(degradedBadge);
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
      currentAppend = next;
      sourceBuffer.appendBuffer(next.data);
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
    if (currentAppend && !currentAppend.isInit && sourceBuffer?.buffered.length) {
      latencyAnchor = {
        arrivedAt: currentAppend.arrivedAt,
        mediaTime: sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1),
      };
    }
    currentAppend = null;
    maintainLiveEdge();
    pump();
    if (state !== 'playing' && video.readyState >= 2) setState('playing');
  }

  function onSourceError() {
    rebuildMediaSource('The browser rejected the video stream.');
  }

  function enqueue(data, arrivedAt = performance.now(), init = isInitSegment(data)) {
    appendQueue.push({ data, arrivedAt, isInit: init });
    pump();
  }

  function onMediaSourceFailure() {
    rebuildMediaSource('The browser media pipeline ended unexpectedly.');
  }

  async function rebuildMediaSource(reason, initData = null, arrivedAt = performance.now()) {
    if (initData) latestInitSegment = { data: initData, arrivedAt };
    if (destroyed || stopping || state === 'degraded' || !streamInfo?.mime || mediaRebuildPromise) return;
    const myGeneration = generation;
    mediaRebuildPromise = (async () => {
      clearMedia();
      initSeen = false;
      await prepareMediaSource(streamInfo.mime, myGeneration);
      if (generation !== myGeneration) return;
      const pendingInit = latestInitSegment;
      if (pendingInit) {
        initSeen = true;
        enqueue(pendingInit.data, pendingInit.arrivedAt, true);
      }
    })();
    try {
      await mediaRebuildPromise;
    } catch (error) {
      if (generation === myGeneration) {
        emit('error', { code: 'STREAM_FAILED', message: reason });
        degrade({ reason, fallback: 'snapshot' });
      }
    } finally {
      mediaRebuildPromise = null;
    }
  }

  function prepareMediaSource(mime, myGeneration) {
    return new Promise((resolve, reject) => {
      mediaSource = new MediaSource();
      mediaSource.addEventListener('sourceended', onMediaSourceFailure);
      mediaSource.addEventListener('error', onMediaSourceFailure);
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
        const bytes = new Uint8Array(data);
        const arrivedAt = performance.now();
        if (isInitSegment(bytes)) {
          latestInitSegment = { data: bytes, arrivedAt };
          if (initSeen) rebuildMediaSource('The stream restarted and the media pipeline could not be reset.', bytes, arrivedAt);
          else {
            initSeen = true;
            enqueue(bytes, arrivedAt, true);
          }
        } else if (!mediaRebuildPromise) {
          enqueue(bytes, arrivedAt, false);
        }
        return;
      }
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (frame.type === 'ready') return;
      if (frame.type === 'stats') {
        let latencyMs = null;
        if (latencyAnchor && Number.isFinite(video.currentTime)) {
          const elapsed = performance.now() - latencyAnchor.arrivedAt;
          const presentationOffset = (latencyAnchor.mediaTime - video.currentTime) * 1_000;
          const estimate = elapsed + presentationOffset;
          if (Number.isFinite(estimate)) latencyMs = Math.max(0, Math.round(estimate));
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
      initSeen = false;
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
    initSeen = false;
    latestInitSegment = null;
    mediaRebuildPromise = null;
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
      if (SNAPSHOT_FALLBACK_CODES.has(detail.code)) {
        // The player recovered into a working mode, so this resolves instead
        // of rethrowing — callers treat a rejected start() as "nothing to
        // show", which is exactly what degrade() avoids.
        emit('error', detail);
        degrade({ reason: detail.message, fallback: 'snapshot' });
        return;
      }
      setState('error', detail);
      emit('error', detail);
      throw error;
    }
  }

  function destroy() {
    if (destroyed) return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    video.removeEventListener('error', onVideoError);
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
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') maintainLiveEdge();
  };
  const onVideoError = () => rebuildMediaSource('The browser could not decode the video stream.');
  document.addEventListener('visibilitychange', onVisibilityChange);
  video.addEventListener('error', onVideoError);
  return { start, stop, destroy, on, getState: () => state };
}
