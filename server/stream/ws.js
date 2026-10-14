import { isKeyframeFragment } from './fmp4.js';

/**
 * Send-queue depth at which the relay starts dropping. The 4K cameras this
 * app runs against push ~6000 kbps ≈ 0.75 MB/s, so 1 MiB of bufferedAmount is
 * already ~1.3s of queued video — latency the viewer can see. The previous
 * 4 MiB threshold meant ~5s of staleness before anything was shed, and what
 * it shed (individual 200ms fragments, mid-GOP) corrupted the picture anyway.
 */
const BACKPRESSURE_BYTES = 1 * 1024 * 1024;

function sendJson(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

export function handleStreamSocket(ws, url, ctx) {
  const sessionId = url.searchParams.get('session');
  const streamId = url.searchParams.get('stream');
  const session = sessionId ? ctx.getSession(sessionId) : undefined;
  if (!session) {
    ws.close(4001, 'Session expired');
    return;
  }
  const handle = streamId ? ctx.pipeline.getStream(streamId) : undefined;
  if (!handle || handle.sessionId !== sessionId || !handle.addViewer()) {
    ws.close(4002, 'Stream stopped');
    return;
  }
  session.touch?.();
  let released = false;
  let droppedFrames = 0;
  /**
   * Fragments are cut every 200ms (-frag_duration), NOT on keyframes, so any
   * dropped fragment starves the decoder of its reference frames until the
   * next keyframe — the viewer sees smear or freeze, not a clean skip. Once
   * dropping starts, it must therefore end on a GOP boundary: skip until a
   * fragment that begins with a keyframe, then resume. Never resume mid-GOP.
   *
   * Starts true for the same reason: a viewer joining mid-stream must not be
   * fed mid-GOP fragments before its first keyframe either — the decoder
   * cannot do anything with them.
   */
  let skipping = true;
  const release = () => {
    if (released) return;
    released = true;
    cleanup();
    handle.removeViewer();
  };
  const sendBinary = (data) => {
    if (ws.readyState !== 1) return;
    ws.send(data, { binary: true });
  };
  /**
   * The pipeline may keep the current GOP (fragments from the last keyframe
   * onward) so a late joiner starts immediately instead of waiting up to a
   * full GOP for the next live keyframe. Optional and possibly mid-rebuild,
   * hence the checks: only prime from a non-empty cache that verifiably
   * starts on a keyframe; otherwise fall back to waiting for one live.
   */
  const primeFromGopCache = () => {
    const cache = handle.gopCache;
    if (!Array.isArray(cache) || cache.length === 0 || !isKeyframeFragment(cache[0])) return false;
    for (const fragment of cache) sendBinary(fragment);
    return true;
  };
  const onInit = (data) => {
    sendBinary(data);
    // A fresh init segment means ffmpeg restarted: everything from the old run
    // is undecodable, and the handle's gopCache may still hold stale
    // fragments from it, so do NOT prime here — wait for the new run's first
    // keyframe, which ffmpeg emits almost immediately.
    skipping = true;
  };
  const onFragment = (data) => {
    if (ws.readyState !== 1) return;
    if (!skipping && ws.bufferedAmount > BACKPRESSURE_BYTES) skipping = true;
    if (skipping) {
      if (!isKeyframeFragment(data)) {
        droppedFrames += 1;
        return;
      }
      skipping = false;
    }
    sendBinary(data);
  };
  const onStats = (stats) => sendJson(ws, { type: 'stats', ...stats, droppedFrames });
  const onDegraded = (detail) => sendJson(ws, { type: 'degraded', ...detail });
  const onError = (detail) => sendJson(ws, { type: 'error', ...detail });
  // The encoder changed under us: the client must drop its SourceBuffer and
  // re-prime from a fresh init segment, which a plain reconnect does.
  const onReconfigured = (detail) => sendJson(ws, { type: 'reconfigured', ...detail });
  const onStopped = () => {
    if (ws.readyState === 0 || ws.readyState === 1) {
      ws.close(handle.sessionEnded ? 4001 : 4002, handle.sessionEnded ? 'Session expired' : 'Stream stopped');
    }
  };
  const cleanup = () => {
    handle.off('init', onInit);
    handle.off('fragment', onFragment);
    handle.off('stats', onStats);
    handle.off('degraded', onDegraded);
    handle.off('error', onError);
    handle.off('reconfigured', onReconfigured);
    handle.off('close', onStopped);
  };
  handle.on('init', onInit);
  handle.on('fragment', onFragment);
  handle.on('stats', onStats);
  handle.on('degraded', onDegraded);
  handle.on('error', onError);
  handle.on('reconfigured', onReconfigured);
  handle.on('close', onStopped);
  ws.once('close', release);
  ws.once('error', release);
  sendJson(ws, { type: 'ready', mime: handle.mime });
  if (handle.initSegment) {
    sendBinary(handle.initSegment);
    // Only a viewer that got an init segment can be primed: if initSegment is
    // null a respawn is in flight and anything in gopCache belongs to the dead
    // run, so keep waiting for the new run's init + first keyframe.
    skipping = !primeFromGopCache();
  }
}
