import { Router } from 'express';
import { AppError } from '../errors.js';
import { assertFfmpeg } from '../config.js';
import { requireSession, requireProfile } from '../sessions.js';
import { redactUri } from '../onvif/util.js';
import { startStream, stopStream, getStream } from '../stream/pipeline.js';
import { fetchSnapshot } from '../stream/snapshot.js';
import { readEncoder, writeEncoder } from '../onvif/encoder.js';
import { reconfigureStreams, willDisruptStream, isDisruptiveChange } from '../stream/reconfigure.js';
import { refreshProfiles } from '../onvif/media.js';

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
  let profiles = session.profiles;

  if (req.query?.profile !== undefined) {
    const profileToken = requireProfile(session, req.query.profile);
    const selected = session.profileMap.get(profileToken);
    const sourceToken = selected?.videoSourceToken;

    if (sourceToken) {
      profiles = session.profiles.filter((profile) =>
        session.profileMap.get(profile.token)?.videoSourceToken === sourceToken);
    } else {
      // Some single cameras omit SourceToken even though GetVideoSources makes
      // the grouping unambiguous. Reuse that resolved source, but never group
      // missing tokens together on a recorder.
      const source = session.sources?.find((candidate) =>
        candidate.profiles?.some((profile) => profile.token === profileToken));
      profiles = session.sources?.length === 1 && source
        ? source.profiles
        : session.profiles.filter((profile) => profile.token === profileToken);
    }
  }

  const urls = profiles.map((p) => {
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

router.get('/encoder', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.query?.profile);
  res.json(await readEncoder(session, profileToken));
}));

router.patch('/encoder', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const profileToken = requireProfile(session, req.body?.profile);
  const patch = req.body?.settings;

  // Whether this disrupts anything has to be decided BEFORE the write, because
  // the rebuild below removes the very stream we are asking about.
  const disruptive = isDisruptiveChange(patch) && willDisruptStream(session.id, profileToken);

  const result = await writeEncoder(session, profileToken, patch);

  // Only resolution and codec invalidate the init segment the browser primed
  // MSE with. A bitrate or GOP nudge does not, and forcing a visible restart
  // for one would be a worse experience than leaving the stream running.
  const restarted = reconfigureStreams(session.id, profileToken, patch);

  // The cached profiles still describe the OLD geometry. Refresh before
  // replying, or the next stream/start reports a resolution the camera is no
  // longer producing. Best effort: a stale cache is worse than the write
  // failing, but not worth failing the write over.
  try { await refreshProfiles(session); } catch { /* keep the stale cache */ }

  res.json({ ...result, streamRestartRequired: disruptive, streamsRestarted: restarted });
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
  const session = requireSession(req.params.id);
  const streamId = req.body?.streamId;
  if (!streamId) throw new AppError('BAD_REQUEST', 'A streamId is required.');

  // The WebSocket path (server/stream/ws.js) refuses a stream that is missing
  // and one that belongs to another session with the identical close code. The
  // HTTP path must agree: a stream owned by a different session is reported
  // exactly like one that does not exist, so this response can never confirm
  // that a foreign streamId is real. Stopping a stream that has already ended
  // stays a handled not-found envelope, never a crash or a side effect.
  const stream = getStream(streamId);
  if (!stream || stream.sessionId !== session.id) {
    throw new AppError('NOT_FOUND', 'No such stream for this session.');
  }

  stopStream(streamId);
  res.status(204).end();
}));

export default router;
