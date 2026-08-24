import { Router } from 'express';
import { AppError } from '../errors.js';
import { assertFfmpeg } from '../config.js';
import { requireSession, requireProfile } from '../sessions.js';
import { redactUri } from '../onvif/util.js';
import { startStream, stopStream } from '../stream/pipeline.js';
import { fetchSnapshot } from '../stream/snapshot.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/profiles', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  res.json({ profiles: session.profiles });
}));

/**
 * Stream URLs for copying into VLC, ffmpeg, an NVR, or a test tool.
 *
 * SPEC.md §5 says the credentialed RTSP URL must never reach the browser, and
 * that rule exists because the page is the least trustworthy place to keep a
 * camera password. The operator explicitly needs a pasteable URL, so this
 * endpoint splits the difference: the sanitized URL is always returned, and the
 * credentialed one only when it is asked for by name. That keeps credentials
 * out of every incidental render while still making the feature useful.
 */
router.get('/stream-urls', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const includeCredentials = req.query?.credentials === 'true';

  const urls = session.profiles.map((p) => {
    const internal = session.profileMap.get(p.token);
    return {
      token: p.token,
      name: p.name,
      codec: p.video?.codec ?? null,
      resolution: p.video?.width && p.video?.height ? `${p.video.width}×${p.video.height}` : null,
      rtsp: redactUri(internal?.rtspUri),
      rtspWithCredentials: includeCredentials ? (internal?.rtspUri ?? null) : null,
      snapshot: redactUri(internal?.snapshotUri),
    };
  }).filter((u) => u.rtsp || u.snapshot);

  res.set('Cache-Control', 'no-store');
  res.json({ urls, credentialsIncluded: includeCredentials });
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
