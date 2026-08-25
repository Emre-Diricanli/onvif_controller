import { randomUUID, createHmac } from 'node:crypto';
import { AppError } from '../errors.js';
import { assertSafeHost } from '../onvif/connect.js';

/**
 * Payload shaping, topic classification, and HMAC signing for event fan-out.
 * The wire shape is frozen in FANOUT.md "Shape" — do not add, rename, or drop
 * fields without changing that contract first.
 */

/**
 * Topic -> class mapping, checked in order so the most specific vendors win
 * before the generic motion patterns. Match on the topic path case-insensitively;
 * vendors are inconsistent about casing (Hikvision vs Dahua vs core tns1).
 *
 * The default is 'other', and that is deliberate: a wrong class silently
 * mislabels detections downstream, while 'other' just means "unclassified" and
 * the receiver still gets the original topic and data to route on. Never force
 * an unrecognized topic into a class that merely looks close — extend this
 * table with a real topic string instead.
 */
const CLASS_RULES = [
  { class: 'human', patterns: [/humanshapedetect/i, /humandetect/i, /peopledetection/i] },
  { class: 'vehicle', patterns: [/vehicledetect/i] },
  { class: 'line_crossing', patterns: [/linedetector\/crossed/i, /crosslinedetection/i, /linecrossing/i] },
  { class: 'field_detect', patterns: [/fielddetector/i] },
  { class: 'tamper', patterns: [/tamperdetector/i, /tamper/i] },
  { class: 'audio', patterns: [/audiodetector/i, /audioanalytics/i] },
  { class: 'input', patterns: [/digitalinput/i] },
  { class: 'motion', patterns: [/cellmotiondetector\/motion/i, /motionalarm/i, /\/motion$/i] },
];

export function classify(topic) {
  const raw = String(topic ?? '');
  for (const rule of CLASS_RULES) {
    if (rule.patterns.some((re) => re.test(raw))) return rule.class;
  }
  return 'other';
}

/**
 * Resolve the video source token a profile belongs to, the way CHANNELS.md
 * requires: through the source grouping built at connect time. Returns null
 * when the profile cannot be placed — on a recorder a guessed channel
 * attributes detections to the wrong camera, so unknown is strictly better
 * than wrong.
 */
function resolveSource(session, profileToken) {
  const sources = Array.isArray(session?.sources) ? session.sources : [];
  if (profileToken) {
    const match = sources.find((s) => s.profiles?.some((p) => p.token === profileToken));
    if (match) return match;
  }
  // A single-source device has no ambiguity: media.js makes the same inference
  // when grouping profiles. Never do this on a recorder.
  if (sources.length === 1) return sources[0];
  return null;
}

export function buildPayload(session, event, { profileToken } = {}) {
  const source = resolveSource(session, profileToken);
  return {
    id: randomUUID(),
    source: {
      host: session.host,
      port: session.port,
      channel: source?.token ?? null,
      label: source?.label ?? null,
      profile: profileToken ?? null,
    },
    device: {
      manufacturer: session.device?.manufacturer ?? null,
      model: session.device?.model ?? null,
      serial: session.device?.serial ?? null,
    },
    // The vendor evidence is never rewritten: the original topic string and
    // the original parsed items go out alongside the normalized class.
    topic: event.topic,
    class: classify(event.topic),
    state: event.state ?? null,
    eventTime: event.utcTime,
    receivedAt: new Date().toISOString(),
    data: event.data ?? {},
    snapshot: null,
  };
}

/**
 * HMAC-SHA256 over the EXACT bytes the caller will send. Accepts the serialized
 * body string, not an object: re-serializing here could produce different bytes
 * and a signature that does not match what goes on the wire.
 */
export function signPayload(bodyString, secret) {
  const hex = createHmac('sha256', secret).update(bodyString, 'utf8').digest('hex');
  return `sha256=${hex}`;
}

/**
 * Configuration-time SSRF check for an operator-supplied target URL. Reuses
 * assertSafeHost so the metadata/link-local denylist stays single-source in
 * connect.js — do not copy it here. RFC1918 stays allowed by design: posting
 * to 192.168.x / 10.x edge boxes is the point of the feature.
 */
export function validateTargetUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new AppError('BAD_REQUEST', 'That is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('BAD_REQUEST', 'Only http: and https: target URLs are allowed.');
  }
  // assertSafeHost throws for metadata/link-local hosts, but its message is
  // written for the connect path ("that address is not a camera"), which is
  // confusing when the operator is configuring a webhook. Re-word it for this
  // context while keeping the denylist itself single-source in connect.js.
  try {
    assertSafeHost(parsed.hostname);
  } catch {
    throw new AppError('BAD_REQUEST',
      'That webhook host is blocked.',
      'Link-local and cloud metadata addresses are refused because a webhook target must not be able to reach the host\'s own credentials service. Private LAN addresses are allowed.');
  }
  return url;
}
