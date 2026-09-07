import { Router } from 'express';
import { AppError } from '../errors.js';
import { getGovernor, resetGovernor } from '../device/governor.js';
import { requireSession } from '../sessions.js';
import { readDevice, setRelayOutput, reboot, syncTime } from '../onvif/device.js';
import { readNetwork, writeNetwork } from '../onvif/network.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(async (req, res) => {
  res.json(await readDevice(requireSession(req.params.id)));
}));

// Recovery is scoped to the session's host and must be explicitly requested.
router.get('/governor', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json(getGovernor(session.host).stats());
}));

router.post('/governor/reset', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  getGovernor(session.host);
  res.json(resetGovernor(session.host));
}));

router.get('/network', wrap(async (req, res) => {
  res.json(await readNetwork(requireSession(req.params.id)));
}));

router.patch('/network', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const result = await writeNetwork(session, req.body?.settings);
  if (result.relocation.expected) session.stale = true;
  res.json(result);
}));

router.post('/relay', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const { token, state } = req.body ?? {};
  if (!token) throw new AppError('BAD_REQUEST', 'A relay output token is required.');
  if (state !== 'active' && state !== 'inactive') {
    throw new AppError('BAD_REQUEST', 'State must be "active" or "inactive".');
  }
  await setRelayOutput(session.cam, { token, state }, session.timeoutMs);
  res.status(204).end();
}));

router.post('/reboot', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const message = await reboot(session);
  res.status(202).json({ message });
}));

router.post('/synctime', wrap(async (req, res) => {
  await syncTime(requireSession(req.params.id));
  res.status(204).end();
}));

export default router;
