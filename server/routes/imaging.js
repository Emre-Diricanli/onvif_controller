import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireSession, requireProfile } from '../sessions.js';
import { readImaging, writeImaging, focusMove } from '../onvif/imaging.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.query?.profile);
  res.json(await readImaging(session, profileToken));
}));

router.patch('/', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.body?.profile);
  const settings = req.body?.settings;
  if (!settings || typeof settings !== 'object') {
    throw new AppError('BAD_REQUEST', 'A "settings" object is required.');
  }
  res.json(await writeImaging(session, profileToken, settings));
}));

router.post('/focus', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.body?.profile);
  await focusMove(session, profileToken, {
    action: req.body?.action ?? 'continuous',
    speed: req.body?.speed,
    position: req.body?.position,
  });
  res.status(204).end();
}));

export default router;
