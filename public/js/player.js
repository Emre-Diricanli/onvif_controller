import { decideLiveSync, findGapJumpTarget, recoveryBackoffMs, LIVE_SEEK_BACK_S } from './livesync.js';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

// The playhead has not moved for this long while fragments kept arriving:
// the decode pipeline is wedged in a way seeking cannot fix, so the
// MediaSource gets rebuilt from the latest init segment.
const STALL_REBUILD_MS = 4_000;
// Watchdog-triggered rebuilds give up after this many in a row and degrade to
// snapshots — a wedged pipeline that survives three rebuilds is not going to
// unstick itself, and the honest fallback beats a frozen frame.
const STALL_REBUILD_LIMIT = 3;
// How much history to keep behind the playhead.
const BUFFER_KEEP_S = 10;
// Hidden tabs get no rate catch-up; without this cap a stalled background
// player would let the buffer grow without bound.
const HIDDEN_BUFFER_CAP_S = 12;

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

// A human-readable name for what the browser cannot play, so the degraded
// reason says "H264 (avc1.640028)" instead of "the camera video format".
function describeCodec(info) {
  const codec = typeof info?.codec === 'string' && info.codec.trim();
  const tag = /codecs="?([^";]+)"?/i.exec(info?.mime || '')?.[1];
  if (codec && tag) return `${codec} (${tag})`;
  return codec || tag || 'this camera\'s video format';
}

// null when the browser can play this stream, otherwise the specific reason
// it cannot — checked before a SourceBuffer is ever created.
function unsupportedReason(info) {
  if (typeof MediaSource === 'undefined') {
    return 'This browser does not support Media Source Extensions, so live video cannot play here.';
  }
  let supported = false;
  try { supported = Boolean(info?.mime) && MediaSource.isTypeSupported(info.mime); } catch { supported = false; }
  if (!supported) return `This browser cannot play ${describeCodec(info)} video.`;
  return null;
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
  // Self-healing: background live-video retries while degraded.
  let recoveryTimer = null;
  let recoveryAttempt = 0;
  // True while the snapshot overlay is standing in for a recovering stream:
  // it comes down only when the first decoded frame actually plays, never on
  // a promise that video is coming.
  let revealOnPlay = false;
  // Stall detection: wall-clock of the last appended fragment and the last
  // time the playhead provably moved.
  let watchdogTimer = null;
  let lastDataAt = 0;
  let lastProgressAt = 0;
  let stallRebuilds = 0;

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
    // playbackRate survives src changes on the element; a fresh pipeline has
    // no lag to catch up, so never carry an old catch-up rate into it.
    video.playbackRate = 1;
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

  function scheduleRecovery() {
    if (destroyed || stopping || state !== 'degraded' || recoveryTimer) return;
    // Hidden tabs pause the retry loop; becoming visible re-arms it (see the
    // visibilitychange hook at the bottom).
    if (document.visibilityState === 'hidden') return;
    const delay = recoveryBackoffMs(recoveryAttempt);
    recoveryAttempt += 1;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      attemptLiveRecovery(generation);
    }, delay);
  }

  async function attemptLiveRecovery(myGeneration) {
    if (destroyed || stopping || state !== 'degraded' || generation !== myGeneration) return;
    try {
      // keepSnapshot: the snapshot overlay stays up as the underlay while the
      // new stream negotiates, and comes down on the first played frame.
      await begin(profileToken, { keepSnapshot: true });
      // Resolved means either live again (the 'playing' hook swaps the
      // overlay out) or begin() re-degraded on a fallback code, which
      // re-armed this same backoff itself.
    } catch {
      if (generation !== myGeneration) return;
      // A hard failure (session gone, camera unreachable): begin() already
      // surfaced the error event. Stay on snapshots instead of leaving the
      // error screen up — that is what the degraded state is for — and let
      // the backoff continue.
      setState('degraded');
      pollSnapshot(generation);
      scheduleRecovery();
    }
  }

  function degrade(detail, { keepSocket = false } = {}) {
    if (destroyed || stopping) return;
    // Re-entry must not arm a second polling chain: pollSnapshot skips a tick
    // only while a fetch is in flight, so a duplicate degrade with the poll
    // timer merely pending would leave two timers respawning each other.
    if (state === 'degraded') return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket && !keepSocket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    // A server-degraded socket stays open (keepSocket): the pipeline retries
    // in the background and pushes a fresh init segment down this same socket
    // when it recovers, which is a cheaper path back to live than a full
    // reconnect. Fragments arriving meanwhile are dropped in onmessage.
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
    scheduleRecovery();
  }

  function evictOldBuffer({ aggressive = false } = {}) {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return false;
    const buffered = sourceBuffer.buffered;
    const now = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    // Trim history older than ~BUFFER_KEEP_S behind the playhead. The cut
    // never reaches the playhead itself: removing media out from under the
    // decoder risks a gap at exactly the moment the viewer is watching. The
    // minimum slice keeps every fragment append from triggering a tiny remove.
    const keepFrom = now - BUFFER_KEEP_S;
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = Math.min(buffered.end(i), keepFrom);
      if (end - start > 1) {
        sourceBuffer.remove(start, end);
        return true;
      }
    }
    if (!aggressive) return false;
    // Quota pressure is the only caller that goes further: trim the oldest
    // history up to a second behind the playhead, still never past it.
    const removeEnd = Math.min(buffered.end(buffered.length - 1) - 1, now - 1);
    if (removeEnd > buffered.start(0)) {
      sourceBuffer.remove(buffered.start(0), removeEnd);
      return true;
    }
    return false;
  }

  function maintainLiveEdge() {
    if (!sourceBuffer?.buffered.length) return;
    const buffered = sourceBuffer.buffered;
    const liveEdge = buffered.end(buffered.length - 1);
    if (!Number.isFinite(liveEdge)) return;
    const hidden = document.visibilityState === 'hidden';
    const decision = decideLiveSync({ currentTime: video.currentTime, bufferedEnd: liveEdge, hidden });
    let seekTo = decision.seekTo;
    if (hidden && seekTo === null && Number.isFinite(video.currentTime)
        && liveEdge - video.currentTime > HIDDEN_BUFFER_CAP_S) {
      seekTo = Math.max(0, liveEdge - LIVE_SEEK_BACK_S);
    }
    if (seekTo !== null) {
      try { video.currentTime = seekTo; } catch { /* The range may have shifted under the seek. */ }
    }
    // Only touch playbackRate when it actually changes: some browsers re-create
    // the render path on every assignment, which shows up as micro-stutter.
    if (Number.isFinite(decision.playbackRate)
        && Math.abs(video.playbackRate - decision.playbackRate) > 0.005) {
      video.playbackRate = decision.playbackRate;
    }
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
        if (!evictOldBuffer({ aggressive: true })) setTimeout(pump, 100);
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
    lastDataAt = performance.now();
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
          // A fresh pipeline gets the full stall grace window before the
          // watchdog may judge it.
          lastProgressAt = performance.now();
          stallRebuilds = 0;
          armWatchdog();
          video.play().catch(() => {});
          resolve();
        } catch (error) { reject(error); }
      }, { once: true });
    });
  }

  // The server's background retry recovered a degraded pipeline and pushed a
  // fresh init segment down the socket degrade() kept open: leave snapshot
  // mode and re-prime MSE from it.
  async function recoverWithInit(myGeneration, initData, arrivedAt) {
    if (generation !== myGeneration || state !== 'degraded' || mediaRebuildPromise) return;
    const mime = streamInfo?.mime;
    if (!mime || unsupportedReason(streamInfo)) {
      scheduleRecovery();
      return;
    }
    // Cancel the client-side retry and the snapshot polling — live video won
    // the race — but keep the last snapshot on screen until the first decoded
    // frame plays: swap onto video, never onto a black flash. State moves to
    // 'connecting' so the normal machinery (fragment intake, rebuilds, the
    // stall watchdog) works unchanged while the pipeline re-primes.
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    snapshotAbortController?.abort();
    snapshotAbortController = null;
    revealOnPlay = true;
    setState('connecting');
    try {
      clearMedia();
      initSeen = false;
      await prepareMediaSource(mime, myGeneration);
      if (generation !== myGeneration) return;
      initSeen = true;
      enqueue(initData, arrivedAt, true);
    } catch {
      if (generation !== myGeneration) return;
      // Re-priming failed before it started: back to snapshots, and the
      // backoff continues.
      setState('degraded');
      pollSnapshot(generation);
      scheduleRecovery();
    }
  }

  function onPlaybackStall() {
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return;
    const buffered = sourceBuffer.buffered;
    const ranges = [];
    for (let i = 0; i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
    const jump = findGapJumpTarget(ranges, video.currentTime);
    if (jump !== null) {
      try { video.currentTime = jump; } catch { /* The range may have shifted under the seek. */ }
    }
  }

  function armWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(watchdogTick, 1_000);
  }

  function watchdogTick() {
    if (destroyed || stopping || !sourceBuffer) return;
    if (state === 'degraded' || state === 'idle' || state === 'error') return;
    // Hidden tabs: playback progress is not expected and the server's own
    // grace logic owns the stream until the page is visible again.
    if (document.visibilityState === 'hidden') return;
    // Backstop for gap stranding — 'waiting'/'stalled' usually fire first.
    onPlaybackStall();
    const now = performance.now();
    const dataArriving = now - lastDataAt < STALL_REBUILD_MS;
    const noProgress = now - lastProgressAt > STALL_REBUILD_MS;
    if (!dataArriving || !noProgress || mediaRebuildPromise) return;
    stallRebuilds += 1;
    // Resetting the progress clock bounds rebuilds to one per grace window.
    lastProgressAt = now;
    if (stallRebuilds >= STALL_REBUILD_LIMIT) {
      degrade({ reason: 'The stream kept arriving but the browser could not play it.', fallback: 'snapshot' });
      return;
    }
    rebuildMediaSource('Playback stalled while stream data kept arriving; rebuilding the media pipeline.');
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
          if (state === 'degraded') {
            recoverWithInit(myGeneration, bytes, arrivedAt);
          } else if (initSeen) {
            rebuildMediaSource('The stream restarted and the media pipeline could not be reset.', bytes, arrivedAt);
          } else {
            initSeen = true;
            enqueue(bytes, arrivedAt, true);
          }
        } else if (state === 'degraded') {
          // No SourceBuffer exists while degraded; dropping fragments here
          // keeps appendQueue from growing without bound on a kept-open socket.
        } else if (!mediaRebuildPromise) {
          enqueue(bytes, arrivedAt, false);
        }
        return;
      }
      let frame;
      try { frame = JSON.parse(data); } catch { return; }
      if (frame.type === 'ready') {
        // A recovered pipeline may re-announce its mime; track it so a later
        // re-prime creates the right SourceBuffer type.
        if (frame.mime && streamInfo) streamInfo = { ...streamInfo, mime: frame.mime };
        return;
      }
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
        degrade({ reason: frame.reason, fallback: frame.fallback }, { keepSocket: true });
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
      const unsupported = unsupportedReason(nextInfo);
      if (unsupported) {
        stopRemote(streamId);
        streamId = null;
        degrade({ reason: unsupported, fallback: 'snapshot' });
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

  function stop({ keepSnapshot = false } = {}) {
    generation += 1;
    stopping = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, 'Player stopped');
      socket = null;
    }
    const oldStreamId = streamId;
    streamId = null;
    stopRemote(oldStreamId);
    if (keepSnapshot) {
      // Freeze the poll chain but keep the overlay: it becomes the underlay
      // for the recovering stream until the first frame plays.
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
      snapshotAbortController?.abort();
      snapshotAbortController = null;
    } else {
      removeSnapshot();
    }
    revealOnPlay = false;
    clearMedia();
    initSeen = false;
    latestInitSegment = null;
    mediaRebuildPromise = null;
    reconnectAttempt = 0;
    stallRebuilds = 0;
    stopping = false;
    if (!destroyed) setState('idle');
  }

  async function begin(nextProfileToken, { keepSnapshot = false } = {}) {
    if (destroyed) throw new Error('The player has been destroyed.');
    stop({ keepSnapshot });
    const myGeneration = generation;
    profileToken = nextProfileToken;
    if (keepSnapshot) revealOnPlay = true;
    setState('connecting');
    try {
      streamInfo = await api('/stream/start', { method: 'POST', body: JSON.stringify({ profile: profileToken }) });
      if (generation !== myGeneration) {
        stopRemote(streamInfo.streamId);
        return;
      }
      streamId = streamInfo.streamId;
      const unsupported = unsupportedReason(streamInfo);
      if (unsupported) {
        stopRemote(streamId);
        streamId = null;
        degrade({ reason: unsupported, fallback: 'snapshot' });
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

  async function start(nextProfileToken) {
    // A deliberate (re)start — profile switch, channel switch, the "Try
    // again" button — resets the degraded-retry backoff.
    recoveryAttempt = 0;
    return begin(nextProfileToken, { keepSnapshot: false });
  }

  function destroy() {
    if (destroyed) return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    offPageInactive();
    video.removeEventListener('error', onVideoError);
    video.removeEventListener('playing', onVideoPlaying);
    video.removeEventListener('timeupdate', onTimeUpdate);
    video.removeEventListener('waiting', onPlaybackStall);
    video.removeEventListener('stalled', onPlaybackStall);
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
    if (document.visibilityState !== 'visible') return;
    // Back from the background: re-sync to the live edge (a large enough lag
    // hard-seeks), make sure playback is actually running, and resume the
    // degraded-retry loop if it was paused while hidden.
    if (mediaSource && video.paused && state !== 'degraded') video.play().catch(() => {});
    maintainLiveEdge();
    if (state === 'degraded') scheduleRecovery();
  };
  // Rate catch-up is pointless work in a hidden tab (timers are throttled
  // anyway) and the background retry should not burn camera connections
  // nobody is watching. Blur and pointercancel are gesture concerns, not
  // playback ones, so only genuine page inactivity pauses anything.
  const offPageInactive = onPageInactive((reason) => {
    if (reason !== 'hidden' && reason !== 'pagehide') return;
    video.playbackRate = 1;
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  });
  const onVideoError = () => rebuildMediaSource('The browser could not decode the video stream.');
  const onVideoPlaying = () => {
    // Real forward progress: both retry loops reset here, so a stream that
    // recovered earns back its fast backoff.
    stallRebuilds = 0;
    recoveryAttempt = 0;
    if (state === 'degraded') setState('playing');
    if (revealOnPlay) {
      revealOnPlay = false;
      removeSnapshot();
    }
  };
  const onTimeUpdate = () => {
    lastProgressAt = performance.now();
    stallRebuilds = 0;
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  video.addEventListener('error', onVideoError);
  video.addEventListener('playing', onVideoPlaying);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('waiting', onPlaybackStall);
  video.addEventListener('stalled', onPlaybackStall);
  return { start, stop, destroy, on, getState: () => state };
}
