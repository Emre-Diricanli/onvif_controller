import { Router } from 'express';
import { AppError } from '../errors.js';
import { connectDevice, discoverDevices } from '../onvif/connect.js';
import { createSession, requireSession, destroySession, serializeSession } from '../sessions.js';

const router = Router();

/** Wrap an async handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/connect', wrap(async (req, res) => {
  const { host, port, username, password } = req.body ?? {};
  if (!username) throw new AppError('BAD_REQUEST', 'A username is required.');
  if (password === undefined || password === null) {
    throw new AppError('BAD_REQUEST', 'A password is required.');
  }

  const parsedPort = Number(port ?? 80);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new AppError('BAD_REQUEST', 'Port must be a whole number between 1 and 65535.');
  }

  const result = await connectDevice({ host, port: parsedPort, username, password });
  const session = createSession({
    host: result.cam.hostname ?? host,
    port: parsedPort,
    username,
    password,
    ...result,
  });

  // Skew is reported rather than fatal: the connect already succeeded, so digest
  // still works, but it is about to stop working and the operator should know.
  res.json(serializeSession(session, { includeId: true }));
}));

router.get('/session/:id', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json(serializeSession(session));
}));

router.post('/session/:id/disconnect', wrap(async (req, res) => {
  destroySession(req.params.id);
  res.status(204).end();
}));

router.post('/discover', wrap(async (req, res) => {
  const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs ?? 5000), 1000), 15000);
  const devices = await discoverDevices(timeoutMs);
  res.json({ devices });
}));

export default router;
