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
      videoSourceName: p?.videoSourceConfiguration?.name ?? null,
    });
  }

  // Main stream first: it is what an operator means by "the camera".
  profiles.sort((a, b) => (b.video.width ?? 0) - (a.video.width ?? 0));
  return { profiles, profileMap };
}

function sourceToken(source) {
  const token = source?.$?.token ?? source?.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function suppliedName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Group the client-safe profiles by their ONVIF VideoSource token. */
export function describeSources(rawSources, profiles, profileMap, { imaging = false } = {}) {
  const realSources = asArray(rawSources);
  const grouped = new Map();
  const sources = [];

  for (const raw of realSources) {
    const token = sourceToken(raw);
    if (!token || grouped.has(token)) continue;
    const source = {
      token,
      label: null,
      profiles: [],
      ptzSupported: false,
      imagingSupported: Boolean(imaging),
    };
    grouped.set(token, { source, sourceName: suppliedName(raw?.name), names: [], profileNames: [] });
    sources.push(source);
  }

  const ungrouped = [];
  for (const profile of profiles) {
    const detail = profileMap.get(profile.token);
    // With exactly one real source there is no ambiguity: this preserves the
    // existing single-camera behavior for devices that publish a placeholder
    // or omit sourceToken. Never make this inference on a recorder.
    const group = grouped.get(detail?.videoSourceToken)
      ?? (grouped.size === 1 ? grouped.values().next().value : null);
    if (!group) {
      ungrouped.push(profile);
      continue;
    }
    group.source.profiles.push(profile);
    group.source.ptzSupported ||= Boolean(profile.ptzSupported);
    const name = suppliedName(detail?.videoSourceName);
    if (name) group.names.push(name);
    const profileName = suppliedName(profile.name);
    if (profileName) group.profileNames.push(profileName);
  }

  // A source-configuration name is useful only when it distinguishes this
  // source. Generic repeated names such as "VideoSourceConfig" do not.
  const nameCounts = new Map();
  const sourceNameCounts = new Map();
  const profileNameCounts = new Map();
  for (const group of grouped.values()) {
    if (group.sourceName) sourceNameCounts.set(group.sourceName, (sourceNameCounts.get(group.sourceName) ?? 0) + 1);
    for (const name of new Set(group.names)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    for (const name of new Set(group.profileNames)) profileNameCounts.set(name, (profileNameCounts.get(name) ?? 0) + 1);
  }
  for (const [index, source] of sources.entries()) {
    const group = grouped.get(source.token);
    const uniqueSourceName = sourceNameCounts.get(group.sourceName) === 1 ? group.sourceName : null;
    const uniqueConfigName = group.names.find((name) => nameCounts.get(name) === 1);
    const distinctProfileNames = [...new Set(group.profileNames)];
    const uniqueProfileName = distinctProfileNames.length === 1
      && profileNameCounts.get(distinctProfileNames[0]) === 1 ? distinctProfileNames[0] : null;
    // A "name" that merely repeats the token is not a name. Cameras commonly
    // echo the token here, which would surface as "videoSourceToken" in the UI.
    // Reject names that are plainly internal ONVIF plumbing rather than
    // something an operator chose. A recorder that never had its channels named
    // reports "VideoSourceConfig 3", which is worse in the UI than "Channel 3"
    // because it looks like information while carrying none.
    const GENERIC = /^(video)?source(config(uration)?)?[\s_-]*\d*$|^videoencoder|^profile[\s_-]*\d*$|^channel[\s_-]*\d*$/i;
    const named = [uniqueSourceName, uniqueConfigName, uniqueProfileName]
      .find((n) => n && n !== source.token && !GENERIC.test(n.trim()));
    source.label = named ?? `Channel ${index + 1}`;
  }

  if (ungrouped.length) {
    sources.push({
      token: null,
      label: 'Unknown source',
      profiles: ungrouped,
      ptzSupported: ungrouped.some((profile) => profile.ptzSupported),
      imagingSupported: false,
    });
  }

  // If GetVideoSources failed and profiles omitted source tokens, retain the
  // one-source API shape without pretending the profiles belong to channel 1.
  if (sources.length === 0) {
    sources.push({
      token: null,
      label: 'Unknown source',
      profiles: [],
      ptzSupported: false,
      imagingSupported: false,
    });
  }

  return sources;
}

export async function getVideoEncoderOptions(cam, profileToken, ctx) {
  return tryCam(cam, 'getVideoEncoderConfigurationOptions', { profileToken }, null, { ctx });
}

/**
 * Re-read a session's profiles after the encoder configuration changed.
 *
 * `session.profiles` and `session.profileMap` are captured at connect time and
 * carry the resolution, codec and framerate. Change the encoder and those
 * become stale: the stream really is 1920x1080 while every API response still
 * claims 2880x1616, so the stats overlay confidently reports the wrong
 * geometry. Refresh the cache in place so existing references stay valid.
 */
export async function refreshProfiles(session) {
  const { profiles, profileMap } = await describeProfiles(session.cam, {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    ctx: session.ctx,
  });

  session.profiles = profiles;
  session.profileMap.clear();
  for (const [token, profile] of profileMap) session.profileMap.set(token, profile);
  session.sources = describeSources(session.cam?.videoSources, profiles, session.profileMap, session.capabilities);
  session.isMultiChannel = session.sources.length > 1;
  return profiles;
}
