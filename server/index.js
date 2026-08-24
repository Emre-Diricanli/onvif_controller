import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { config, warnIfExposed } from './config.js';
import { errorMiddleware, AppError } from './errors.js';
import { getSession, shutdownAllSessions, onSessionDestroyed } from './sessions.js';
import sessionRoutes from './routes/session.js';
import mediaRoutes from './routes/media.js';
import ptzRoutes from './routes/ptz.js';
import imagingRoutes from './routes/imaging.js';
import deviceRoutes from './routes/device.js';
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

app.use('/api', sessionRoutes);
app.use('/api/session/:id', mediaRoutes);
app.use('/api/session/:id/ptz', ptzRoutes);
app.use('/api/session/:id/imaging', imagingRoutes);
app.use('/api/session/:id/device', deviceRoutes);

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
onSessionDestroyed((sessionId) => {
  try { pipeline.stopAllForSession(sessionId); } catch { /* ignore */ }
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
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  warnIfExposed();
  console.log(`ONVIF Controller  →  http://${config.host}:${config.port}`);
  if (!config.ffmpegPath) {
    console.warn('  ffmpeg not found on PATH — live streaming will fall back to snapshot polling.');
  } else {
    console.log(`  ffmpeg: ${config.ffmpegPath}`);
  }
});

export { app, server };
