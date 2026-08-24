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
  const release = () => {
    if (released) return;
    released = true;
    cleanup();
    handle.removeViewer();
  };
  const sendBinary = (data, countDrop = false) => {
    if (ws.readyState !== 1) return;
    if (countDrop && ws.bufferedAmount > 4 * 1024 * 1024) {
      droppedFrames += 1;
      return;
    }
    ws.send(data, { binary: true });
  };
  const onInit = (data) => sendBinary(data);
  const onFragment = (data) => sendBinary(data, true);
  const onStats = (stats) => sendJson(ws, { type: 'stats', ...stats, droppedFrames });
  const onDegraded = (detail) => sendJson(ws, { type: 'degraded', ...detail });
  const onError = (detail) => sendJson(ws, { type: 'error', ...detail });
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
    handle.off('close', onStopped);
  };
  handle.on('init', onInit);
  handle.on('fragment', onFragment);
  handle.on('stats', onStats);
  handle.on('degraded', onDegraded);
  handle.on('error', onError);
  handle.on('close', onStopped);
  ws.once('close', release);
  ws.once('error', release);
  sendJson(ws, { type: 'ready', mime: handle.mime });
  if (handle.initSegment) sendBinary(handle.initSegment);
}
