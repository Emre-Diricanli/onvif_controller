import { getSession } from '../sessions.js';

const PING_TIMEOUT_MS = 70_000;

/**
 * Bridge the session's ONVIF event bus onto a WebSocket.
 * Called by server/index.js after it has routed the upgrade by pathname.
 */
export function handleEventsSocket(ws, url) {
  const sessionId = url.searchParams.get('session');
  const session = sessionId ? getSession(sessionId) : null;

  if (!session) {
    send(ws, { type: 'error', code: 'SESSION_EXPIRED', message: 'That session is no longer active.' });
    ws.close(4001, 'Session expired');
    return;
  }
  if (!session.capabilities.events) {
    send(ws, { type: 'error', code: 'UNSUPPORTED', message: 'This device does not support ONVIF events.' });
    ws.close(4003, 'Events unsupported');
    return;
  }

  const bus = session.events;
  const onEvent = (event) => send(ws, event);
  const onLifecycle = (frame) => send(ws, frame);

  bus.on('event', onEvent);
  bus.on('lifecycle', onLifecycle);
  if (bus.subscribed) send(ws, { type: 'subscribed' });

  // The client pings every 25s. If nothing arrives for well over that, the
  // socket is half-open and holding an event listener; drop it.
  let idleTimer = resetIdle();
  function resetIdle() {
    clearTimeout(idleTimer);
    return setTimeout(() => ws.close(4008, 'Idle'), PING_TIMEOUT_MS);
  }

  ws.on('message', (raw) => {
    idleTimer = resetIdle();
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg?.type === 'ping') {
      session.touch();
      send(ws, { type: 'pong' });
    }
  });

  const cleanup = () => {
    clearTimeout(idleTimer);
    bus.removeListener('event', onEvent);
    bus.removeListener('lifecycle', onLifecycle);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* socket died mid-send */ }
}
