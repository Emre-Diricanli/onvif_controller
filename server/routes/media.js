import { Router } from 'express';
import { AppError } from '../errors.js';
import { assertFfmpeg } from '../config.js';
import { requireSession, requireProfile } from '../sessions.js';
import { startStream, stopStream } from '../stream/pipeline.js';
import { fetchSnapshot } from '../stream/snapshot.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/profiles', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json({ profiles: session.profiles });
}));

router.get('/snapshot', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.query?.profile);
  const { contentType, body } = await fetchSnapshot(session, profileToken);
  res.set('Content-Type', contentType || 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(body);
}));

router.post('/stream/start', wrap(async (req, res) => {
  assertFfmpeg();
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.body?.profile);

  const profile = session.profileMap.get(profileToken);
  if (!profile?.rtspUri) {
    throw new AppError('UNSUPPORTED', 'This profile does not expose an RTSP stream.',
      'On a Hikvision NVR, confirm the channel is online and the ONVIF user may view it.');
  }

  res.json(await startStream(session, profileToken));
}));

router.post('/stream/stop', wrap(async (req, res) => {
  requireSession(req.params.id);
  const streamId = req.body?.streamId;
  if (!streamId) throw new AppError('BAD_REQUEST', 'A streamId is required.');
  stopStream(streamId);
  res.status(204).end();
}));

export default router;
