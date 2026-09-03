/**
 * Standing regression tests for four field bug classes (GOVERNOR.md, "The eight
 * bug classes"). Plain check(name, ok, detail) style, like tools/smoke.mjs —
 * no framework, no network, no real hardware. Called from the smoke runner:
 *
 *   const { bugClassChecks } = await import('./bugclass-tests.mjs');
 *   await bugClassChecks(check);
 *
 * Every check pins behavior that was broken on a real device; revert the
 * corresponding fix and the check goes red.
 */
import { EventEmitter } from 'node:events';

/**
 * Bug class 5 — stale profile cache. A device reported 2880x1616 from
 * GetProfiles while actually streaming 1080p: `session.profiles` and
 * `session.profileMap` are captured at connect time, and once the encoder
 * geometry changes every API response keeps claiming the stale numbers while
 * the stream delivers different ones. The fix is `refreshProfiles`
 * (server/onvif/media.js), which re-reads the device and refreshes the cache
 * IN PLACE so references already held by routes and the stream pipeline see
 * the new geometry instead of the stale one.
 */
async function staleProfileCacheChecks(check) {
  console.log('\nStale profile cache');
  const { describeProfiles, refreshProfiles } = await import('../server/onvif/media.js');

  if (typeof refreshProfiles !== 'function') {
    check('a profile-cache refresh mechanism exists', false,
      'refreshProfiles is missing from server/onvif/media.js — nothing re-reads the device after an encoder change, so the connect-time cache goes stale (2880x1616 served while the stream is 1080p)');
    return;
  }

  // GetProfiles first claims 2880x1616 while the device actually encodes 1080p.
  let geometry = { width: 2880, height: 1616 };
  let profileReads = 0;
  const cam = {
    videoSources: [{ $: { token: 'VideoSource_1' }, name: 'Camera 1' }],
    getProfiles(cb) {
      profileReads += 1;
      cb(null, [{
        $: { token: 'profile-1' },
        name: 'Main stream',
        videoEncoderConfiguration: {
          encoding: 'H264',
          resolution: { ...geometry },
          rateControl: { frameRateLimit: 25, bitrateLimit: 4096 },
        },
        videoSourceConfiguration: { $: { token: 'vsc-1' }, sourceToken: 'VideoSource_1', name: 'Camera 1' },
      }]);
    },
    getStreamUri({ profileToken }, cb) { cb(null, { uri: `rtsp://device:554/stream/${profileToken}` }); },
    getSnapshotUri({ profileToken }, cb) { cb(null, { uri: `http://device/snap/${profileToken}.jpg` }); },
  };

  const session = {
    cam, host: '10.1.10.70', port: 80, username: 'admin', password: 'secret',
    ctx: {}, capabilities: {},
  };

  // The connect-time cache, as createSession stores it.
  const { profiles, profileMap } = await describeProfiles(cam, {
    host: session.host, port: session.port, username: session.username, password: session.password, ctx: session.ctx,
  });
  session.profiles = profiles;
  session.profileMap = profileMap;
  // Routes and the stream pipeline keep holding this very reference.
  const heldMap = session.profileMap;

  check('the cache first serves what GetProfiles reported',
    session.profiles[0].video.width === 2880 && session.profiles[0].video.height === 1616,
    `${session.profiles[0].video.width}x${session.profiles[0].video.height}`);

  // The device now reports the truth: the encoder really produces 1080p.
  geometry = { width: 1920, height: 1080 };
  await refreshProfiles(session);

  check('refresh re-reads the device rather than reshuffling the cache',
    profileReads === 2, `GetProfiles called ${profileReads} time(s)`);
  check('after refresh the cache reports the true geometry, not the stale 2880x1616',
    session.profiles[0].video.width === 1920 && session.profiles[0].video.height === 1080,
    `${session.profiles[0].video.width}x${session.profiles[0].video.height}`);
  check('the refresh happens in place, so held references see the new data',
    heldMap === session.profileMap && heldMap.get('profile-1').video.width === 1920,
    heldMap === session.profileMap
      ? `width ${heldMap.get('profile-1')?.video?.width}`
      : 'profileMap was replaced; existing references would keep serving stale geometry');
  check('no cached field still carries the stale geometry',
    !JSON.stringify([session.profiles, [...session.profileMap.values()]]).includes('2880'));
  check('the source grouping is rebuilt from the refreshed profiles',
    session.sources?.[0]?.profiles?.[0]?.video?.width === 1920,
    JSON.stringify(session.sources?.[0]?.profiles?.[0]?.video));
}

/**
 * Bug class 6 — the event channel lives in the message's own Source simpleItem
 * (Name="Source", Value="Media7"), NOT in a profile token; observed on the
 * 32-channel UNIX IPM32R32P, whose pull-point MotionAlarm events carry no
 * profile token at all. Wrong-channel attribution is the worst failure mode
 * this app has, so the contract pinned here is: resolve by exact token, report
 * an unknown token verbatim, and never silently fall back to channel 1 on a
 * multi-channel device.
 */
async function sourceItemChannelChecks(check) {
  console.log('\nEvent channel in the Source item');
  const { buildPayload } = await import('../server/fanout/payload.js');

  const session = {
    host: '192.168.12.129', port: 80,
    device: { manufacturer: 'UNIX', model: 'IPM32R32P' },
    sources: [
      { token: 'Media1', label: 'Channel 1', profiles: [{ token: 'P1' }] },
      { token: 'Media7', label: 'Channel 7', profiles: [{ token: 'P13' }] },
      { token: 'Media16', label: 'Channel 16', profiles: [{ token: 'P31' }] },
    ],
  };
  const motion = (source) => ({
    topic: 'tns1:VideoSource/MotionAlarm',
    state: true,
    utcTime: '2026-08-25T16:45:46.000Z',
    source,
    data: { State: true },
  });

  const resolved = buildPayload(session, motion({ Source: 'Media16' }), { profileToken: null });
  check('a Source item resolves to its own channel',
    resolved.source.channel === 'Media16' && resolved.source.label === 'Channel 16',
    JSON.stringify(resolved.source));

  const second = buildPayload(session, motion({ Source: 'Media7' }), { profileToken: null });
  check('resolution is by exact token, not position or first match',
    second.source.channel === 'Media7' && second.source.label === 'Channel 7',
    JSON.stringify(second.source));

  // A channel the app does not know is still what the device said: report it
  // verbatim with no label rather than remapping it to something familiar.
  const unknown = buildPayload(session, motion({ Source: 'Media99' }), { profileToken: null });
  check('an unknown Source value is reported verbatim, never remapped or defaulted',
    unknown.source.channel === 'Media99' && unknown.source.label === null,
    JSON.stringify(unknown.source));

  // The regression that matters most: with nothing to attribute on, a
  // multi-channel device must yield NO channel — falling back to channel 1
  // would attribute 31 channels of detections to the wrong camera.
  const unattributable = buildPayload(session, motion(undefined), { profileToken: null });
  check('no Source on a multi-channel device attributes to no channel at all',
    unattributable.source.channel === null && unattributable.source.label === null,
    JSON.stringify(unattributable.source));
  const unknownProfile = buildPayload(session, motion(undefined), { profileToken: 'P999' });
  check('an unknown profile token on a multi-channel device is just as unattributable',
    unknownProfile.source.channel === null,
    JSON.stringify(unknownProfile.source));

  // The no-fallback rule must not break a single-source camera, where the one
  // source is unambiguous (media.js makes the same inference when grouping).
  const single = buildPayload(
    { ...session, sources: [session.sources[0]] }, motion(undefined), { profileToken: null });
  check('a single-source device still resolves its only channel',
    single.source.channel === 'Media1' && single.source.label === 'Channel 1',
    JSON.stringify(single.source));
}

/**
 * Bug class 7 — boolean State coerced by Number(). xml2js sometimes hands back
 * a real boolean; the old Number() coercion turned `false` into 0, so every
 * MotionAlarm on the UNIX IPM32R32P arrived as State:0 with no usable state
 * flag — motion start and stop were indistinguishable. `normalizeMessage` is
 * not exported, so these checks drive it through `attachEvents`, which is the
 * production path from the camera's pull loop to the event bus.
 */
async function booleanStateChecks(check) {
  console.log('\nBoolean State coercion');
  const { attachEvents, __testing } = await import('../server/onvif/events.js');
  const { readItems } = __testing;

  const boolFalse = readItems({ simpleItem: { $: { Name: 'State', Value: false } } });
  check('a real boolean false survives as false, not 0',
    boolFalse.State === false, JSON.stringify(boolFalse));
  const strFalse = readItems({ simpleItem: { $: { Name: 'State', Value: 'false' } } });
  check('the string "false" becomes boolean false',
    strFalse.State === false, JSON.stringify(strFalse));
  const strTrue = readItems({ simpleItem: { $: { Name: 'State', Value: 'true' } } });
  check('the string "true" becomes boolean true',
    strTrue.State === true, JSON.stringify(strTrue));
  const numeric = readItems({ simpleItem: { $: { Name: 'Value', Value: '42' } } });
  check('a genuine numeric value still parses as a number',
    numeric.Value === 42, JSON.stringify(numeric));
  const numericNative = readItems({ simpleItem: { $: { Name: 'Value', Value: 17 } } });
  check('an already-numeric value stays a number',
    numericNative.Value === 17, JSON.stringify(numericNative));

  // The normalized event's `state` flag is what the UI and fan-out consume.
  // Under the Number() coercion, State came back as 0, `typeof` was not
  // 'boolean', and the state flag was silently dropped to null.
  function normalize(rawMessage) {
    const cam = new EventEmitter();
    const bus = attachEvents({ cam });
    const seen = [];
    bus.on('event', (event) => seen.push(event));
    cam.emit('event', rawMessage);
    return seen[0];
  }

  const rawMotion = (stateValue) => ({
    topic: { _: 'tns1:VideoSource/MotionAlarm' },
    message: {
      message: {
        $: { UtcTime: '2026-08-25T16:45:46.000Z' },
        source: { simpleItem: { $: { Name: 'Source', Value: 'Media7' } } },
        data: { simpleItem: { $: { Name: 'State', Value: stateValue } } },
      },
    },
  });

  const fromBool = normalize(rawMotion(false));
  check('a normalized event keeps boolean false as its state flag',
    fromBool?.state === false && fromBool?.data?.State === false,
    JSON.stringify(fromBool ?? 'no event emitted'));
  const fromStrFalse = normalize(rawMotion('false'));
  check('a normalized event turns "false" into boolean false',
    fromStrFalse?.state === false,
    JSON.stringify(fromStrFalse ?? 'no event emitted'));
  const fromStrTrue = normalize(rawMotion('true'));
  check('motion start still reads as state true',
    fromStrTrue?.state === true,
    JSON.stringify(fromStrTrue ?? 'no event emitted'));
  const fromNumber = normalize({
    topic: { _: 'tns1:VideoSource/Analytics/Value' },
    message: {
      message: {
        $: { UtcTime: '2026-08-25T16:45:46.000Z' },
        data: { simpleItem: { $: { Name: 'Value', Value: '1' } } },
      },
    },
  });
  check('a numeric item is never mistaken for a boolean state flag',
    fromNumber?.state === null && fromNumber?.data?.Value === 1,
    JSON.stringify(fromNumber ?? 'no event emitted'));
}

/**
 * Bug class 8 — service XAddrs pinned to the literal string "undefined".
 * connectDevice returns no host/port (createSession adds them in the app), so
 * the standalone probe CLI rewrote every recording/replay/search XAddr to
 * http://undefined/... and every request hung. Exposed by AR504-32
 * (192.168.15.101), the first reachable recorder advertising Profile G.
 *
 * The old check pattern-matched the CLI source text; these drive the actual
 * code path — discoverServices and pinHost through probePlayback — against a
 * local fake camera, no network involved.
 */
async function undefinedXaddrChecks(check) {
  console.log('\nUndefined XAddr pinning');
  const { probePlayback } = await import('../server/onvif/playback.js');

  const svc = (ns, path) => ({
    namespace: `http://www.onvif.org/${ns}/wsdl`,
    // A recorder advertises its own LAN address, which we cannot reach.
    XAddr: `http://192.168.99.9/onvif/${path}`,
  });
  function recorder(sent) {
    return {
      _envelopeHeader: () => '<E>', _envelopeFooter: () => '</E>',
      services: [
        svc('ver10/recording', 'recording'),
        svc('ver10/replay', 'replay'),
        svc('ver10/search', 'search'),
      ],
      uri: {},
      _parseUrl: (u) => new URL(u),
      // Raw xml2js shape (every node an array) with no SearchToken, so the
      // probe ends its search cleanly after the first Find* call.
      _request: (opts, cb) => { sent.push(String(opts.url)); cb(null, [{}], ''); },
    };
  }

  // With the host attached — as both callers do since the fix — every XAddr is
  // pinned to the address the operator typed, and so is every request sent.
  const sent = [];
  const pinned = await probePlayback(
    { cam: recorder(sent), host: '10.1.10.70', timeoutMs: 300, sources: [] }, {});
  const pinnedUrls = Object.values(pinned.services).map((s) => s.url);
  check('service XAddrs are pinned to the operator host, not the self-reported LAN address',
    pinnedUrls.every((u) => typeof u === 'string' && u.includes('10.1.10.70') && !u.includes('192.168.99.9')),
    pinnedUrls.join(' | '));
  check('no pinned XAddr contains the literal string "undefined"',
    pinnedUrls.every((u) => typeof u === 'string' && !u.includes('undefined')),
    pinnedUrls.join(' | '));
  check('every request the probe actually sends goes to the pinned host',
    sent.length > 0 && sent.every((u) => u.includes('10.1.10.70') && !u.includes('undefined')),
    sent.join(' | ') || 'no requests were sent');

  // The field regression itself, driven behaviorally: a session whose host is
  // missing must never yield XAddrs of http://undefined/... — either the probe
  // produces nothing malformed or it refuses cleanly. This check currently
  // FAILS, documenting the gap: pinHost() coerces a missing host to the
  // literal hostname "undefined", and the only protection is caller discipline
  // (tools/probe-playback.mjs assigns session.host before probing). The guard
  // belongs in playback.js so no future caller can resurrect the bug.
  let hostlessReport = null;
  let hostlessError = null;
  try {
    hostlessReport = await probePlayback({ cam: recorder([]), timeoutMs: 300, sources: [] }, {});
  } catch (err) {
    hostlessError = err;
  }
  const hostlessUrls = hostlessReport
    ? Object.values(hostlessReport.services).map((s) => s.url).filter((u) => typeof u === 'string')
    : [];
  check('a session with no host never yields an XAddr containing "undefined"',
    hostlessError !== null || (hostlessUrls.length > 0 && hostlessUrls.every((u) => !u.includes('undefined'))),
    hostlessError
      ? `refused cleanly: ${hostlessError.message}`
      : `no module-level guard — pinHost produced ${hostlessUrls.join(' | ')}`);
}

export async function bugClassChecks(check) {
  const sections = [
    ['stale profile cache', staleProfileCacheChecks],
    ['event channel in the Source item', sourceItemChannelChecks],
    ['boolean State coercion', booleanStateChecks],
    ['undefined XAddr pinning', undefinedXaddrChecks],
  ];
  for (const [name, fn] of sections) {
    try {
      await fn(check);
    } catch (err) {
      // A section that throws (say, a reverted export) must not silently eat
      // the remaining bug classes; report it as a red check instead.
      check(`${name}: section ran to completion`, false,
        `threw: ${String(err?.message ?? err)}`);
    }
  }
}
