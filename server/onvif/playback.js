import { asArray, redactUri } from './util.js';

/**
 * ONVIF Profile G probe — recorded video playback.
 *
 * Read-only by construction. See PLAYBACK.md: the Recording service also
 * carries CreateRecordingJob / DeleteRecording / SetRecordingJobMode, which
 * destroy an operator's footage. Nothing in this module may call a Create*,
 * Delete* or Set* method, and `assertReadOnly()` below enforces that on every
 * raw SOAP body we build rather than trusting review to catch it.
 *
 * The `onvif` library covers Recording and Replay but ships no search.js at
 * all, so FindRecordings / FindEvents / GetRecordingSearchResults are built
 * here by hand — the same approach `imaging.js` already takes for
 * SetImagingSettings.
 */

const SEARCH_NS = 'http://www.onvif.org/ver10/search/wsdl';

const SERVICE_NS = {
  recording: /ver10\/recording\/wsdl/i,
  replay: /ver10\/replay\/wsdl/i,
  search: /ver10\/search\/wsdl/i,
};

/**
 * A probe step never throws. Every one of them records what the device actually
 * did and lets the run continue — a recorder with replay but no search is a
 * real and useful answer, and a probe that aborts on the first gap tells us
 * nothing. See PLAYBACK.md "Honest failure".
 */
async function step(report, name, fn) {
  const entry = { step: name, status: 'unsupported', detail: null };
  report.steps.push(entry);
  try {
    // A step marks itself 'ok' only when it actually observed something. The
    // default stays 'unsupported' so a skipped step can never be mistaken for
    // a passing one — reporting a capability we did not exercise is the exact
    // dishonesty this probe exists to avoid.
    return await fn(entry);
  } catch (err) {
    entry.status = 'failed';
    entry.detail = faultText(err);
    return null;
  }
}

/** Surface the device's own fault text; never invent an explanation for it. */
function faultText(err) {
  const raw = err?.message ?? String(err ?? 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400);
}

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Refuse to emit a mutating SOAP body. This is a belt-and-braces guard: the
 * probe has no reason to build one, so if this ever fires it means a future
 * edit introduced a destructive call and it should fail loudly in development
 * rather than quietly delete a customer's recordings.
 */
function assertReadOnly(body) {
  const op = /^<\s*(?:\w+:)?([A-Za-z]+)/.exec(body.trim());
  const name = op?.[1] ?? '';
  if (/^(Create|Delete|Set|Remove|Start|Stop)/.test(name)) {
    throw new Error(`refusing to send mutating recording operation "${name}"`);
  }
  return body;
}

/**
 * `cam._request` resolves `service` against `cam.uri[key]` and, when the key is
 * missing, silently treats the string as a literal request path — which sends
 * a search call to the wrong endpoint and returns a confusing fault. Pass an
 * explicit URL instead so that fallback can never engage. (PLAYBACK.md)
 */
function rawRequest(cam, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('no service URL to send this request to'));
      return;
    }
    // `_requestPart2` uses options.url directly as the http request options, so
    // it must be a parsed URL object — a string silently yields
    // "getaddrinfo ENOTFOUND undefined". `_parseUrl` also applies the library's
    // preserveAddress rule, which pins the device's self-reported LAN address
    // back to the address the operator actually reached it on.
    const parsed = typeof url === 'string' ? cam._parseUrl(url) : url;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`the device did not answer within ${timeoutMs}ms`));
    }, timeoutMs);

    const done = (err, data, xml) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ data, xml });
    };

    try {
      cam._request({
        url: parsed,
        body: cam._envelopeHeader() + assertReadOnly(body) + cam._envelopeFooter(),
      }, done);
    } catch (err) {
      done(err);
    }
  });
}

function callCamP(cam, method, arg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fn = cam?.[method];
    if (typeof fn !== 'function') {
      reject(new Error(`the onvif library does not implement "${method}"`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`the device did not answer "${method}" within ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };
    try {
      if (arg === undefined) fn.call(cam, done);
      else fn.call(cam, arg, done);
    } catch (err) {
      done(err);
    }
  });
}

/**
 * Which Profile G services the device advertises, and where.
 *
 * cam.js:618 invents a recording XAddr by string-replacing "replay" with
 * "recording" when the device advertised replay but not recording. That guess
 * is frequently wrong, so record whether each URL was advertised or guessed —
 * a later recording failure is then attributable to the guess rather than
 * reported as a device fault.
 */
function discoverServices(cam) {
  const services = asArray(cam.services);
  const out = {};

  for (const [key, pattern] of Object.entries(SERVICE_NS)) {
    const match = services.find((s) => typeof s?.namespace === 'string' && pattern.test(s.namespace));
    if (match?.XAddr) {
      out[key] = { present: true, url: match.XAddr, origin: 'advertised', version: readVersion(match) };
    } else {
      out[key] = { present: false, url: null, origin: null, version: null };
    }
  }

  // The library's replay->recording guess, surfaced honestly rather than hidden.
  if (!out.recording.present && out.replay.present && cam.uri?.recording?.href) {
    out.recording = { present: true, url: cam.uri.recording.href, origin: 'guessed', version: null };
  }
  return out;
}

function readVersion(service) {
  const v = service?.version;
  if (!v) return null;
  const major = v.major ?? v.Major;
  const minor = v.minor ?? v.Minor;
  return major === undefined ? null : `${major}.${minor ?? 0}`;
}

/**
 * A recorder hands back its own LAN address in service XAddrs, exactly as it
 * does for stream URIs. We can only reach it at the address the operator typed.
 */
function pinHost(url, host) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== host) parsed.hostname = host;
    return parsed.toString();
  } catch {
    return url;
  }
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function describeTrack(track) {
  const cfg = track?.configuration ?? track;
  return {
    token: cfg?.trackToken ?? track?.trackToken ?? null,
    type: cfg?.trackType ?? null,
    description: cfg?.description ?? null,
    dataFrom: isoOrNull(track?.dataFrom),
    dataTo: isoOrNull(track?.dataTo),
  };
}

/**
 * Recordings and media profiles identify a channel in two different
 * namespaces, and nothing in the spec makes them match. Report both sides and
 * say plainly whether a mapping was derivable — never invent one.
 *
 * This is the same class of bug as the wrong-channel imaging write in
 * CHANNELS.md. Guessing here shows the operator footage from a camera they did
 * not select, which is worse than showing nothing.
 */
function mapChannels(recordings, sources) {
  const profileSide = sources.map((s) => ({
    sourceToken: s.token,
    label: s.label,
    profiles: asArray(s.profiles).map((p) => p.token),
  }));

  const recordingSide = recordings.map((r) => ({
    recordingToken: r.token,
    sourceId: r.source?.sourceId ?? null,
    sourceName: r.source?.name ?? null,
    location: r.source?.location ?? null,
  }));

  const matches = [];
  const unmatchedRecordings = [];

  for (const rec of recordingSide) {
    const candidates = [rec.sourceId, rec.sourceName].filter(Boolean).map(String);
    const hit = profileSide.find((p) => candidates.some((c) => {
      const token = String(p.sourceToken);
      return c === token || c.toLowerCase() === token.toLowerCase();
    }));
    if (hit) matches.push({ recordingToken: rec.recordingToken, sourceToken: hit.sourceToken, basis: 'exact-token-match' });
    else unmatchedRecordings.push(rec.recordingToken);
  }

  return {
    // Only an exact identifier match counts. Anything softer (index order,
    // substring, trailing digits) is a guess dressed up as a mapping.
    derivable: recordingSide.length > 0 && unmatchedRecordings.length === 0,
    strategy: 'exact identifier match only; no positional or fuzzy fallback',
    matches,
    unmatchedRecordings,
    profileSide,
    recordingSide,
  };
}

/**
 * FindRecordings opens server-side state on the recorder: a search session with
 * a token and a timeout. Every one we open must be ended, including on the
 * error path, or we leak search handles on the operator's device.
 */
async function withSearch(cam, url, timeoutMs, startBody, run) {
  const started = await rawRequest(cam, url, startBody, timeoutMs);
  const token = findSearchToken(started.data);
  if (!token) throw new Error('the device accepted the search but returned no SearchToken');
  try {
    return await run(token);
  } finally {
    try {
      await rawRequest(cam, url, `<EndSearch xmlns="${SEARCH_NS}"><SearchToken>${esc(token)}</SearchToken></EndSearch>`, timeoutMs);
    } catch {
      // A failed EndSearch must not mask the real result; the session will
      // expire on its own. Nothing actionable to report here.
    }
  }
}

/**
 * Pull a SearchToken out of the response without assuming its shape.
 *
 * `cam._request` hands back raw xml2js output, where every node is an array —
 * `{ findRecordingsResponse: [ { searchToken: [ 'TOK' ] } ] }` — not the
 * flattened form `linerase()` produces elsewhere in the library. Handle both,
 * plus the `{ _: 'TOK' }` shape xml2js uses for text with attributes.
 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textOf(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object' && typeof value._ === 'string') return value._;
  return null;
}

function findSearchToken(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [key, value] of entries) {
    if (/(^|:)searchToken$/i.test(key)) {
      const text = textOf(value);
      if (text) return text;
    }
  }
  for (const [, value] of entries) {
    const found = findSearchToken(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Gather every node whose key matches, across both xml2js and linerased shapes. */
function collect(node, keyPattern, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return [];
  const out = [];
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
  for (const [key, value] of entries) {
    // Array indices are positional, never a match — recurse through them.
    if (!Array.isArray(node) && keyPattern.test(key)) out.push(...asArray(value));
    else out.push(...collect(value, keyPattern, depth + 1));
  }
  return out;
}

export async function probePlayback(session, { from, to, onStep } = {}) {
  const { cam, host } = session;
  const timeoutMs = session.timeoutMs ?? 10000;
  const windowTo = to ? new Date(to) : new Date();
  const windowFrom = from ? new Date(from) : new Date(windowTo.getTime() - 24 * 3600 * 1000);

  const report = {
    window: { from: windowFrom.toISOString(), to: windowTo.toISOString() },
    services: null,
    capabilities: {},
    recordings: [],
    summary: null,
    channelMapping: null,
    search: { recordings: null, events: null },
    replay: null,
    seek: null,
    steps: [],
    conclusion: null,
  };

  const note = (entry) => { if (typeof onStep === 'function') onStep(entry); };

  // 1. Service presence.
  const services = discoverServices(cam);
  for (const key of Object.keys(services)) {
    if (services[key].url) services[key].url = pinHost(services[key].url, host);
  }
  report.services = services;
  report.steps.push({
    step: 'services',
    status: services.recording.present || services.replay.present ? 'ok' : 'unsupported',
    detail: services.recording.origin === 'guessed'
      ? 'The recording URL was not advertised; the onvif library derived it from the replay URL. A recording failure below may be caused by that guess rather than by the device.'
      : null,
  });
  note(report.steps.at(-1));

  const searchUrl = services.search.url;

  // No Profile G at all is a complete, useful answer — stop cleanly.
  if (!services.recording.present && !services.replay.present && !services.search.present) {
    report.conclusion = 'This device advertises no ONVIF Profile G service. Recorded playback is not available over ONVIF.';
    return report;
  }

  // 2. Per-service capabilities. This is where ReverseReplay and SessionTimeout
  //    are declared, which decide whether a scrubber is feasible at all.
  await step(report, 'recordingCapabilities', async (entry) => {
    if (!services.recording.present) { entry.detail = 'not advertised'; return null; }
    const caps = await callCamP(cam, 'getRecordingServiceCapabilities', undefined, timeoutMs);
    report.capabilities.recording = caps ?? null;
    entry.status = 'ok';
    return caps;
  });
  note(report.steps.at(-1));

  await step(report, 'replayCapabilities', async (entry) => {
    if (!services.replay.present) { entry.detail = 'not advertised'; return null; }
    const { data } = await rawRequest(cam, services.replay.url,
      '<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/replay/wsdl"/>', timeoutMs);
    const caps = collect(data, /^capabilities$/i)[0] ?? null;
    report.capabilities.replay = caps;
    entry.status = 'ok';
    entry.detail = caps?.$?.ReverseReplay === 'true' || caps?.reverseReplay === true
      ? 'Device declares ReverseReplay support.'
      : 'Device does not declare ReverseReplay; backward scrub will be unavailable or I-frame only.';
    return caps;
  });
  note(report.steps.at(-1));

  // 3. Inventory.
  const recordings = await step(report, 'recordings', async (entry) => {
    if (!services.recording.present) { entry.detail = 'not advertised'; return []; }
    const list = asArray(await callCamP(cam, 'getRecordings', undefined, timeoutMs));
    report.recordings = list.map((r) => ({
      token: r?.recordingToken ?? r?.$?.RecordingToken ?? null,
      source: {
        sourceId: r?.configuration?.source?.sourceId ?? null,
        name: r?.configuration?.source?.name ?? null,
        location: r?.configuration?.source?.location ?? null,
        description: r?.configuration?.source?.description ?? null,
      },
      content: r?.configuration?.content ?? null,
      tracks: asArray(r?.tracks?.track ?? r?.tracks).map(describeTrack),
    }));
    entry.status = 'ok';
    entry.detail = `${report.recordings.length} recording(s).`;
    return report.recordings;
  }) ?? [];
  note(report.steps.at(-1));

  await step(report, 'recordingSummary', async (entry) => {
    if (!services.recording.present) { entry.detail = 'not advertised'; return null; }
    const s = await callCamP(cam, 'getRecordingSummary', undefined, timeoutMs);
    report.summary = {
      dataFrom: isoOrNull(s?.dataFrom),
      dataUntil: isoOrNull(s?.dataUntil),
      numberRecordings: s?.numberRecordings ?? null,
    };
    entry.status = 'ok';
    entry.detail = report.summary.dataFrom
      ? `Footage spans ${report.summary.dataFrom} to ${report.summary.dataUntil}.`
      : 'The device returned no data span.';
    return s;
  });
  note(report.steps.at(-1));

  // 4. Channel mapping — the finding that most affects iteration 2's design.
  report.channelMapping = mapChannels(report.recordings, asArray(session.sources));
  report.steps.push({
    step: 'channelMapping',
    status: report.channelMapping.derivable ? 'ok' : 'unsupported',
    detail: report.channelMapping.derivable
      ? 'Recording sources map onto media profile video sources by exact identifier.'
      : 'Recording source identifiers do NOT match media profile videoSourceTokens. A player must not assume the two line up; the mapping has to come from the device, not from ordering.',
  });
  note(report.steps.at(-1));

  // 5. Search — the timeline data, and the part the library does not implement.
  await step(report, 'findRecordings', async (entry) => {
    if (!searchUrl) {
      entry.detail = 'The device advertises no Search service, so there is no way to query what footage exists in a time range.';
      return null;
    }
    const body =
      `<FindRecordings xmlns="${SEARCH_NS}">` +
      '<Scope>' +
      `<IncludedSources xmlns="http://www.onvif.org/ver10/schema"/>` +
      '</Scope>' +
      '<KeepAliveTime>PT20S</KeepAliveTime>' +
      '</FindRecordings>';
    const results = await withSearch(cam, searchUrl, timeoutMs, body, async (token) => {
      const { data } = await rawRequest(cam, searchUrl,
        `<GetRecordingSearchResults xmlns="${SEARCH_NS}">` +
        `<SearchToken>${esc(token)}</SearchToken>` +
        '<MinResults>1</MinResults><MaxResults>50</MaxResults><WaitTime>PT5S</WaitTime>' +
        '</GetRecordingSearchResults>', timeoutMs);
      return collect(data, /^recordingInformation$/i);
    });
    report.search.recordings = {
      count: results.length,
      items: results.slice(0, 20).map((r) => ({
        token: r?.recordingToken ?? null,
        earliest: isoOrNull(r?.earliestRecording),
        latest: isoOrNull(r?.latestRecording),
        sourceId: r?.source?.sourceId ?? null,
      })),
    };
    entry.status = 'ok';
    entry.detail = `Search returned ${results.length} recording(s).`;
    return results;
  });
  note(report.steps.at(-1));

  await step(report, 'findEvents', async (entry) => {
    if (!searchUrl) { entry.detail = 'no Search service'; return null; }
    const body =
      `<FindEvents xmlns="${SEARCH_NS}">` +
      `<StartPoint>${windowFrom.toISOString()}</StartPoint>` +
      `<EndPoint>${windowTo.toISOString()}</EndPoint>` +
      '<Scope><IncludedSources xmlns="http://www.onvif.org/ver10/schema"/></Scope>' +
      '<IncludeStartState>false</IncludeStartState>' +
      '<KeepAliveTime>PT20S</KeepAliveTime>' +
      '</FindEvents>';
    const results = await withSearch(cam, searchUrl, timeoutMs, body, async (token) => {
      const { data } = await rawRequest(cam, searchUrl,
        `<GetEventSearchResults xmlns="${SEARCH_NS}">` +
        `<SearchToken>${esc(token)}</SearchToken>` +
        '<MinResults>1</MinResults><MaxResults>50</MaxResults><WaitTime>PT5S</WaitTime>' +
        '</GetEventSearchResults>', timeoutMs);
      return collect(data, /^result$/i);
    });
    const topics = [...new Set(results.map((r) => String(r?.event?.topic?._ ?? r?.event?.topic ?? '')).filter(Boolean))];
    report.search.events = { count: results.length, topics };
    entry.status = 'ok';
    entry.detail = results.length
      ? `${results.length} event(s); topics: ${topics.slice(0, 6).join(', ') || 'unnamed'}. These become timeline markers.`
      : 'No events in the window. Either nothing was detected, or the recorder does not index events for search.';
    return results;
  });
  note(report.steps.at(-1));

  // 6. Replay URI — redacted, because it carries credentials.
  await step(report, 'replayUri', async (entry) => {
    if (!services.replay.present) { entry.detail = 'not advertised'; return null; }
    const token = report.recordings[0]?.token ?? report.search.recordings?.items?.[0]?.token;
    if (!token) { entry.detail = 'no recording token available to ask about'; return null; }
    const uri = await callCamP(cam, 'getReplayUri', {
      recordingToken: token,
      streamSetup: { stream: 'RTP-Unicast', transport: { protocol: 'RTSP' } },
    }, timeoutMs);
    const raw = uri?.uri ?? uri;
    report.replay = { recordingToken: token, uri: redactUri(String(raw)) ?? null, transport: 'RTSP' };
    entry.status = 'ok';
    entry.detail = report.replay.uri ? 'Device returned an RTSP replay URI.' : 'Device answered but returned no usable URI.';
    return raw;
  });
  note(report.steps.at(-1));

  // 7. Seek — recorded as a design question, not attempted here. Opening the
  //    stream needs ffmpeg and the credentialed URI; the CLI owns that.
  report.seek = {
    attempted: false,
    note: 'Seek uses the RTSP "Range: clock=..." header at PLAY time. ffmpeg cannot re-seek an in-flight RTSP session, so each scrub costs a process restart unless the device supports Rate-Control/Scale. Measure this before designing a scrubber.',
    reverseReplayDeclared: report.capabilities.replay
      ? (report.capabilities.replay?.$?.ReverseReplay === 'true' || report.capabilities.replay?.reverseReplay === true)
      : null,
  };

  report.conclusion = buildConclusion(report);
  return report;
}

/** State only what was observed. Never infer support from make or model. */
function buildConclusion(report) {
  const have = [];
  const missing = [];
  for (const [key, svc] of Object.entries(report.services)) {
    (svc.present ? have : missing).push(key);
  }
  const parts = [];
  parts.push(have.length ? `Observed services: ${have.join(', ')}.` : 'No Profile G services observed.');
  if (missing.length) parts.push(`Not advertised: ${missing.join(', ')}.`);

  if (!report.services.search.present) {
    parts.push('Without the Search service there is no way to ask what footage exists in a time range, so a timeline would have to be built from GetRecordings spans alone.');
  }
  if (report.channelMapping && !report.channelMapping.derivable) {
    parts.push('Recording sources could not be mapped to media profiles by identifier — iteration 2 must resolve the channel from the device rather than assuming order.');
  }
  return parts.join(' ');
}
