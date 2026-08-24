import { Router } from 'express';
import { requireSession, requireProfile } from '../sessions.js';
import * as ptz from '../onvif/ptz.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ctx = (req) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.body?.profile ?? req.query?.profile);
  return { session, profileToken };
};

router.post('/move', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  const { pan = 0, tilt = 0, zoom = 0 } = req.body ?? {};
  await ptz.continuousMove(session, { profileToken, pan, tilt, zoom });
  res.status(204).end();
}));

router.post('/stop', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  const { panTilt = true, zoom = true } = req.body ?? {};
  await ptz.stopMove(session, { profileToken, panTilt, zoom });
  res.status(204).end();
}));

router.post('/relative', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  const { pan = 0, tilt = 0, zoom = 0, speed = 0.5 } = req.body ?? {};
  await ptz.relativeMove(session, { profileToken, pan, tilt, zoom, speed });
  res.status(204).end();
}));

router.post('/absolute', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  const { pan = 0, tilt = 0, zoom = 0, speed = 0.5 } = req.body ?? {};
  await ptz.absoluteMove(session, { profileToken, pan, tilt, zoom, speed });
  res.status(204).end();
}));

router.get('/status', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  res.json(await ptz.getStatus(session, profileToken));
}));

router.get('/presets', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  res.json({ presets: await ptz.getPresets(session, profileToken) });
}));

router.post('/presets/goto', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  await ptz.gotoPreset(session, { profileToken, token: req.body?.token, speed: req.body?.speed });
  res.status(204).end();
}));

router.post('/presets', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  res.json(await ptz.savePreset(session, {
    profileToken, name: req.body?.name, token: req.body?.token ?? null,
  }));
}));

router.delete('/presets/:token', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  await ptz.removePreset(session, { profileToken, token: req.params.token });
  res.status(204).end();
}));

router.post('/home', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  await ptz.home(session, { profileToken, action: req.body?.action ?? 'goto' });
  res.status(204).end();
}));

router.post('/aux', wrap(async (req, res) => {
  const { session, profileToken } = ctx(req);
  await ptz.auxiliary(session, { profileToken, command: req.body?.command });
  res.status(204).end();
}));

export default router;
