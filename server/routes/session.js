import { Router } from 'express';
import net from 'node:net';
import { AppError, toResponse } from '../errors.js';
import { connectDevice, discoverDevices, resolveSafeHost } from '../onvif/connect.js';
import { createSession, createVendorSession, requireSession, destroySession, serializeSession } from '../sessions.js';
import { listAdapters, getAdapter, probeAll } from '../adapters/index.js';

/**
 * ONVIF errors after which the device is worth asking in its own API. A
 * timeout or a refused request says nothing about the vendor API and would
 * only make the operator wait through every vendor probe, so those rethrow.
 */
const VENDOR_RETRY_CODES = new Set(['UNAUTHORIZED', 'DEVICE_ERROR', 'UNSUPPORTED', 'DEVICE_UNREACHABLE', 'CLOCK_SKEW']);

/**
 * One TCP connect, no payload. An unreachable host must fail in about a
 * second, not after every vendor probe has timed out in turn.
 */
function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function connectVendor({ host: requestedHost, port, username, password, only = null, sendProgress }) {
  // Same SSRF guard and DNS pinning as the ONVIF path: this app makes
  // requests on the operator's behalf, whatever protocol it speaks.
  const host = await resolveSafeHost(requestedHost);
  sendProgress?.({ stage: 'vendor-probe', message: 'Asking the device in its own API' });
  const cfg = { host, port, username, password, timeoutMs: 4000 };
  if (!(await tcpReachable(host, port))) return null;
  const probes = await probeAll(cfg, { only, useCache: false });
  const match = probes.filter((p) => p.match && p.id !== 'onvif').sort((a, b) => b.confidence - a.confidence)[0];
  if (!match) return null;
  const adapter = await getAdapter(match.id);
  const connection = await adapter.connect({ ...cfg, timeoutMs: 8000 });
  const targets = await connection.listTargets();
  return createVendorSession({ host, port, username, password, connection, targets });
}

const router = Router();

/** Wrap an async handler so rejections reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/connect', wrap(async (req, res) => {
  const { host, port, username, password } = req.body ?? {};
  const protocol = req.body?.protocol ?? 'auto';
  if (typeof protocol !== 'string') throw new AppError('BAD_REQUEST', '"protocol" must be a string.');
  if (protocol !== 'auto' && !(await getAdapter(protocol))) {
    throw new AppError('BAD_REQUEST', `Unknown protocol "${protocol}".`);
  }
  if (!username) throw new AppError('BAD_REQUEST', 'A username is required.');
  if (password === undefined || password === null) {
    throw new AppError('BAD_REQUEST', 'A password is required.');
  }

  const parsedPort = Number(port ?? 80);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new AppError('BAD_REQUEST', 'Port must be a whole number between 1 and 65535.');
  }

  const wantsProgress = /(?:^|,)\s*application\/x-ndjson(?:\s*;|\s*,|\s*$)/i
    .test(req.get('accept') ?? '');
  if (wantsProgress) {
    res.status(200).type('application/x-ndjson');
    res.flushHeaders();
  }
  const sendProgress = wantsProgress
    ? (progress) => res.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`)
    : null;

  let session;
  try {
    if (protocol !== 'auto' && protocol !== 'onvif') {
      if (!host) throw new AppError('BAD_REQUEST', 'A host is required.');
      session = await connectVendor({ host, port: parsedPort, username, password, only: [protocol], sendProgress });
      if (!session) throw new AppError('UNSUPPORTED', `The device did not answer as ${protocol}.`);
    } else {
      try {
        const result = await connectDevice(
          { host, port: parsedPort, username, password },
          { onProgress: sendProgress },
        );
        session = createSession({
          host: result.cam.hostname ?? host,
          port: parsedPort,
          username,
          password,
          ...result,
        });
      } catch (onvifError) {
        // ONVIF disabled (common on Hikvision NVRs) or refusing these
        // credentials while the vendor API accepts them (the Lorex N864A6):
        // ask the device in its own API before giving up. The ONVIF error is
        // the one reported if nothing else answers.
        if (protocol !== 'auto' || !host || !VENDOR_RETRY_CODES.has(onvifError?.code)) throw onvifError;
        session = await connectVendor({ host, port: parsedPort, username, password, sendProgress })
          .catch((vendorError) => {
            // A vendor that matched but refused the credentials is the more
            // specific diagnosis.
            if (vendorError?.code === 'UNAUTHORIZED') throw vendorError;
            return null;
          });
        if (!session) throw onvifError;
      }
    }
  } catch (err) {
    if (!wantsProgress) throw err;
    const { body } = toResponse(err);
    res.end(`${JSON.stringify({ type: 'error', ...body })}\n`);
    return;
  }

  // Skew is reported rather than fatal: the connect already succeeded, so digest
  // still works, but it is about to stop working and the operator should know.
  const payload = serializeSession(session, { includeId: true });
  if (wantsProgress) res.end(`${JSON.stringify({ type: 'complete', session: payload })}\n`);
  else res.json(payload);
}));

router.get('/session/:id', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json(serializeSession(session));
}));

router.post('/session/:id/disconnect', wrap(async (req, res) => {
  destroySession(req.params.id);
  res.status(204).end();
}));

/** Which protocols this build can speak, for the Connect screen. */
router.get('/adapters', wrap(async (_req, res) => {
  const adapters = await listAdapters();
  res.json({ adapters: adapters.map((a) => ({ id: a.id, label: a.label, defaultPorts: a.defaultPorts ?? [80] })) });
}));

router.post('/discover', wrap(async (req, res) => {
  const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs ?? 5000), 1000), 15000);
  const devices = await discoverDevices(timeoutMs);
  res.json({ devices });
}));

export default router;
