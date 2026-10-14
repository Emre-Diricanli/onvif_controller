import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireSession } from '../sessions.js';
import { listTargets, describeSettings, readSettings, writeSettings } from '../settings/service.js';

/**
 * The protocol-neutral settings surface (API.md "Settings"). The same three
 * calls work whether the session reached the device over ONVIF or a vendor API;
 * every response names the adapter that produced it.
 */
const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireTarget(value) {
  if (typeof value !== 'string' || !value) throw new AppError('BAD_REQUEST', 'A "target" is required.');
  return value;
}

router.get('/targets', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json({ protocol: session.protocol, targets: await listTargets(session) });
}));

router.get('/settings/describe', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json(await describeSettings(session, requireTarget(req.query?.target)));
}));

router.get('/settings', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const keys = typeof req.query?.keys === 'string' && req.query.keys ? req.query.keys.split(',') : undefined;
  res.json(await readSettings(session, requireTarget(req.query?.target), keys));
}));

router.patch('/settings', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const target = requireTarget(req.body?.target);
  const values = req.body?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new AppError('BAD_REQUEST', 'A "values" object is required.');
  }
  res.json(await writeSettings(session, target, values));
}));

export default router;
