import { callCam, tryCam, asArray, num, authorizeUri } from './util.js';

function readVideo(cfg) {
  if (!cfg) return { codec: null, width: null, height: null, fps: null, bitrate: null };
  const encoding = String(cfg.encoding ?? cfg.Encoding ?? '').toUpperCase();
  return {
    // Hikvision reports H265 as "H265"; ONVIF ver10 only knows JPEG/MPEG4/H264,
    // so an unknown value here usually means H.265 via the Media2 service.
    codec: encoding || null,
    width: num(cfg.resolution?.width),
    height: num(cfg.resolution?.height),
    fps: num(cfg.rateControl?.frameRateLimit),
    bitrate: num(cfg.rateControl?.bitrateLimit),
  };
}

function readAudio(cfg) {
  if (!cfg) return null;
  return {
    codec: String(cfg.encoding ?? '').toUpperCase() || null,
    bitrate: num(cfg.bitrate),
    sampleRate: num(cfg.sampleRate),
  };
}

/**
 * Enumerate profiles and resolve a playable, credentialed RTSP URI for each.
 *
 * Stream and snapshot URI resolution are both best-effort per profile: an NVR
 * with an offline channel will fault on that one profile while the rest work,
 * and losing the whole connection over it would be wrong.
 */
export async function describeProfiles(cam, { host, port, username, password, ctx }) {
  const raw = asArray(await callCam(cam, 'getProfiles', undefined, { ctx }));
  const profiles = [];
  const profileMap = new Map();

  for (const p of raw) {
    const token = p?.$?.token ?? p?.token;
    if (!token) continue;

    const video = readVideo(p.videoEncoderConfiguration);
    const audio = readAudio(p.audioEncoderConfiguration);

    const streamUri = await tryCam(
      cam, 'getStreamUri',
      { protocol: 'RTSP', profileToken: token },
      null, { ctx },
    );
    const snapshotUri = await tryCam(
      cam, 'getSnapshotUri', { profileToken: token }, null, { ctx },
    );

    const rtspUri = authorizeUri(streamUri?.uri, { host, port: null, username, password });
    const snapUri = authorizeUri(snapshotUri?.uri, { host, port, username, password });

    profiles.push({
      token,
      name: p?.name ?? token,
      video,
      audio,
      ptzSupported: Boolean(p?.PTZConfiguration),
      snapshotSupported: Boolean(snapUri),
      streamSupported: Boolean(rtspUri),
    });

    profileMap.set(token, {
      token,
      name: p?.name ?? token,
      rtspUri,
      snapshotUri: snapUri,
      video,
      audio,
      ptzConfigurationToken: p?.PTZConfiguration?.$?.token ?? null,
      videoSourceToken: p?.videoSourceConfiguration?.sourceToken ?? null,
      videoSourceConfigToken: p?.videoSourceConfiguration?.$?.token ?? null,
    });
  }

  // Main stream first: it is what an operator means by "the camera".
  profiles.sort((a, b) => (b.video.width ?? 0) - (a.video.width ?? 0));
  return { profiles, profileMap };
}

export async function getVideoEncoderOptions(cam, profileToken, ctx) {
  return tryCam(cam, 'getVideoEncoderConfigurationOptions', { profileToken }, null, { ctx });
}
