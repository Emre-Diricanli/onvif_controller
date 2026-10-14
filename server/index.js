import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, warnIfExposed } from './config.js';
import { errorMiddleware, AppError } from './errors.js';
import { getSession, shutdownAllSessions, onSessionDestroyed, onSessionCreated } from './sessions.js';
import sessionRoutes from './routes/session.js';
import mediaRoutes from './routes/media.js';
import ptzRoutes from './routes/ptz.js';
import imagingRoutes from './routes/imaging.js';
import deviceRoutes from './routes/device.js';
import playbackRoutes from './routes/playback.js';
import settingsRoutes from './routes/settings.js';
import fanoutRoutes from './routes/fanout.js';
import { attachFanout } from './fanout/index.js';
import { getTargets, ensureTargetsLoaded, targetLoadErrors, attachSnapshot } from './fanout/config.js';
import * as pipeline from './stream/pipeline.js';
import { handleStreamSocket } from './stream/ws.js';
import { handleEventsSocket } from './ws/events.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');


/**
 * The app has no authentication of its own: anything that can reach it can drive
 * the camera. Browsers do not apply CORS to WebSocket upgrades, so without this
 * any page the operator visits could open /ws/events or /ws/stream against
 * localhost. Enforce same-origin on both surfaces.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, native clients, and same-origin GETs send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// The app proxies camera control with no auth of its own, so keep it same-origin.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  // Session ids travel in URLs; don't leak them to any third party.
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api', (req, res, next) => {
  if (isSameOrigin(req)) return next();
  next(new AppError('BAD_REQUEST', 'Cross-origin requests are not accepted.',
    'Open the controller directly at its own address rather than embedding it in another page.'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: Boolean(config.ffmpegPath) });
});

app.use('/api', fanoutRoutes);
app.use('/api', sessionRoutes);
app.use('/api/session/:id', mediaRoutes);
// A vendor-only session (ADAPTERS.md) has no ONVIF client. Refuse the
// ONVIF-only surfaces up front with a clear envelope instead of letting each
// handler trip over a missing `cam`.
const VENDOR_SAFE = new Set(['disconnect', 'settings', 'targets']);
app.use('/api/session/:id/:feature', (req, _res, next) => {
  const session = getSession(req.params.id);
  if (session && !session.cam && !VENDOR_SAFE.has(req.params.feature)) {
    next(new AppError('UNSUPPORTED', `This device is connected through ${session.connection?.label ?? 'a vendor API'}, not ONVIF.`,
      'Live video, PTZ and events need ONVIF. Use the device settings panel instead.'));
    return;
  }
  next();
});
app.use('/api/session/:id', settingsRoutes);
app.use('/api/session/:id/ptz', ptzRoutes);
app.use('/api/session/:id/imaging', imagingRoutes);
app.use('/api/session/:id/device', deviceRoutes);
app.use('/api/session/:id', playbackRoutes);

app.use('/api', (_req, _res, next) => {
  next(new AppError('NOT_FOUND', 'No such API endpoint.'));
});

app.use(express.static(publicDir, { extensions: ['html'], maxAge: 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use(errorMiddleware);

const server = createServer(app);

// One WebSocketServer, routed by pathname. Streaming must not register its own
// upgrade handler or the two would race for the same socket.
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
const wsCtx = { getSession, pipeline };

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }

  if (!isSameOrigin(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  if (url.pathname !== '/ws/stream' && url.pathname !== '/ws/events') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    try {
      if (url.pathname === '/ws/stream') handleStreamSocket(ws, url, wsCtx);
      else handleEventsSocket(ws, url, wsCtx);
    } catch (err) {
      console.error('[ws] handler failed:', err?.message ?? err);
      try { ws.close(1011, 'Handler error'); } catch { /* already gone */ }
    }
  });
});

// Tearing down a session must also tear down anything streaming from it.
const fanoutDetachers = new Map();

onSessionDestroyed((sessionId) => {
  try { pipeline.stopAllForSession(sessionId); } catch { /* ignore */ }
  const detach = fanoutDetachers.get(sessionId);
  if (detach) {
    fanoutDetachers.delete(sessionId);
    try { detach(); } catch { /* ignore */ }
  }
});

/**
 * Attach webhook fan-out to each new session.
 *
 * Fan-out lives as long as the session, not the browser tab — and no longer.
 * When the operator disconnects, delivery stops (FANOUT.md "Lifetime").
 * Configuration is server-side via FANOUT_CONFIG; with no config file the
 * dispatcher has no targets and attachFanout is a no-op, so the feature stays
 * completely inert unless it was deliberately turned on.
 */
onSessionCreated((session) => {
  try {
    const targets = getTargets();
    if (!targets.length) return;
    const detach = attachFanout(session, targets, { attachSnapshot });
    fanoutDetachers.set(session.id, detach);
  } catch (err) {
    // An event bridge must never prevent a camera from connecting.
    console.warn('  fan-out could not attach to this session:', String(err?.message ?? err));
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down.`);
  try { shutdownAllSessions(); } catch { /* ignore */ }
  for (const ws of wss.clients) {
    try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
  }
  server.close(() => process.exit(0));
  // ffmpeg children are killed by the pipeline's own exit hook; this is the
  // backstop for a hung socket keeping the process alive.
  setTimeout(() => process.exit(0), 3000).unref();
}
/**
 * Last-resort safety net.
 *
 * The `onvif` library throws synchronously from inside its own async callbacks
 * (its event pull loop is the known offender), which no caller can catch. A
 * camera hiccup must not take down an operator's live view and every other
 * session on this server, so log loudly and keep serving rather than exiting.
 *
 * This deliberately does NOT swallow the error quietly: an unexpected throw is
 * still a defect worth seeing in the log.
 */
process.on('uncaughtException', (err) => {
  console.error('[uncaught] Continuing after an unhandled error:', err?.stack ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason?.stack ?? reason);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Kick the target load off before accepting connections. A bad config file
// degrades to "fan-out disabled" rather than preventing the app from starting,
// so this promise never rejects.
const fanoutReady = ensureTargetsLoaded().catch((err) => {
  console.warn('  fan-out: target configuration could not be read:', String(err?.message ?? err));
  return [];
});

server.listen(config.port, config.host, () => {
  warnIfExposed();
  console.log(`ONVIF Controller  →  http://${config.host}:${config.port}`);
  if (!config.ffmpegPath) {
    console.warn('  ffmpeg not found on PATH — live streaming will fall back to snapshot polling.');
  } else {
    console.log(`  ffmpeg: ${config.ffmpegPath}`);
  }

  // Report what fan-out loaded. The load itself is kicked off before listen()
  // so a session cannot connect ahead of its targets; this only awaits the
  // same promise to print the result.
  fanoutReady.then(() => {
    const targets = getTargets();
    const errors = targetLoadErrors();
    if (targets.length) {
      console.log(`  fan-out: ${targets.length} webhook target(s) from FANOUT_CONFIG.`);
    } else if (process.env.FANOUT_CONFIG) {
      console.warn('  fan-out: FANOUT_CONFIG is set but no usable targets were loaded.');
    }
    for (const error of errors) console.warn(`  fan-out: ${error}`);
  });
});

export { app, server };
