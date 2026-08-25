import { chmod, readFile, writeFile } from 'node:fs/promises';
import { fetchSnapshot } from '../stream/snapshot.js';
import { validateTargetUrl } from './payload.js';

const DEFAULT_DELIVERY = { queueSize: 100, concurrency: 4, timeoutMs: 10_000 };
const DEFAULT_SNAPSHOT_INTERVAL = 5_000;
const snapshotChannels = new Map();

let targets = [];
let loadErrors = [];
let loaded = false;

function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer.`);
  return value;
}

async function normalizeTarget(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Target must be an object.');
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('Target id must be a non-empty string.');
  if (typeof value.url !== 'string' || !value.url.trim()) throw new Error('Target url must be a non-empty string.');
  const validatedUrl = await validateTargetUrl(value.url);
  if (value.filters !== undefined && (!Array.isArray(value.filters)
    || value.filters.some((filter) => typeof filter !== 'string' || !filter.trim()))) {
    throw new Error('Target filters must be an array of non-empty strings.');
  }
  if (value.secret !== undefined && typeof value.secret !== 'string') throw new Error('Target secret must be a string.');

  const snapshot = value.snapshot ?? {};
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Target snapshot must be an object.');
  }
  if (snapshot.topics !== undefined && (!Array.isArray(snapshot.topics)
    || snapshot.topics.some((topic) => typeof topic !== 'string' || !topic.trim()))) {
    throw new Error('Snapshot topics must be an array of non-empty strings.');
  }
  const delivery = value.delivery ?? {};
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new Error('Target delivery must be an object.');
  }

  return {
    id: value.id.trim(),
    url: String(validatedUrl ?? value.url),
    enabled: value.enabled !== false,
    secret: value.secret ?? '',
    filters: value.filters?.map((filter) => filter.trim()) ?? [],
    snapshot: {
      enabled: snapshot.enabled === true,
      topics: snapshot.topics?.map((topic) => topic.trim()) ?? [],
      minIntervalMs: positiveInteger(snapshot.minIntervalMs, DEFAULT_SNAPSHOT_INTERVAL,
        `Target ${index} snapshot.minIntervalMs`),
    },
    delivery: {
      queueSize: positiveInteger(delivery.queueSize, DEFAULT_DELIVERY.queueSize, `Target ${index} delivery.queueSize`),
      concurrency: positiveInteger(delivery.concurrency, DEFAULT_DELIVERY.concurrency,
        `Target ${index} delivery.concurrency`),
      timeoutMs: positiveInteger(delivery.timeoutMs, DEFAULT_DELIVERY.timeoutMs, `Target ${index} delivery.timeoutMs`),
    },
  };
}

export async function loadTargets(configPath = process.env.FANOUT_CONFIG) {
  loaded = true;
  targets = [];
  loadErrors = [];
  if (!configPath) return { enabled: false, targets, errors: loadErrors };

  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    loadErrors.push({ index: null, reason: `Could not load fan-out configuration: ${error.message}` });
    return { enabled: true, targets, errors: loadErrors };
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.targets;
  if (!Array.isArray(entries)) {
    loadErrors.push({ index: null, reason: 'Fan-out configuration must be an array or an object with a targets array.' });
    return { enabled: true, targets, errors: loadErrors };
  }

  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    try {
      const target = await normalizeTarget(entries[index], index);
      if (seen.has(target.id)) throw new Error(`Duplicate target id "${target.id}".`);
      seen.add(target.id);
      targets.push(target);
    } catch (error) {
      loadErrors.push({ index, id: typeof entries[index]?.id === 'string' ? entries[index].id : null,
        reason: String(error?.message ?? error).slice(0, 300) });
    }
  }
  return { enabled: true, targets, errors: loadErrors };
}

export async function ensureTargetsLoaded() {
  if (!loaded) await loadTargets();
  return targets;
}

export function getTargets() {
  return targets;
}

export function getTarget(id) {
  return targets.find((target) => target.id === id) ?? null;
}

export function targetLoadErrors() {
  return loadErrors.map((error) => ({ ...error }));
}

export function redactedTargets() {
  return targets.map(({ secret, ...target }) => ({
    ...target,
    filters: [...target.filters],
    snapshot: { ...target.snapshot, topics: [...target.snapshot.topics] },
    delivery: { ...target.delivery },
    hasSecret: Boolean(secret),
  }));
}

export async function writeTargets(nextTargets, configPath = process.env.FANOUT_CONFIG) {
  if (!configPath) throw new Error('FANOUT_CONFIG is not set.');
  await writeFile(configPath, `${JSON.stringify(nextTargets, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return loadTargets(configPath);
}

function snapshotError(error) {
  return String(error?.message ?? error ?? 'Snapshot failed.').replace(/\s+/g, ' ').slice(0, 200);
}

/** Always resolves, including when the camera snapshot request fails. */
export function attachSnapshot(event, target, session, profileToken) {
  const config = target?.snapshot;
  const matches = !config?.topics?.length || config.topics.some((topic) =>
    event?.topic?.includes(topic) || event?.class === topic);
  if (!config?.enabled || !matches) return Promise.resolve({ ...event, snapshot: null });

  const channel = event?.source?.channel ?? profileToken;
  const key = `${session?.id ?? 'session'}:${channel ?? 'channel'}`;
  const state = snapshotChannels.get(key) ?? { inFlight: null, lastStartedAt: 0 };
  snapshotChannels.set(key, state);

  const now = Date.now();
  let request = state.inFlight;
  if (!request && now - state.lastStartedAt >= config.minIntervalMs) {
    state.lastStartedAt = now;
    request = fetchSnapshot(session, profileToken)
      .then(({ contentType, body }) => ({ contentType, data: body.toString('base64') }))
      .finally(() => { state.inFlight = null; });
    state.inFlight = request;
  }
  if (!request) return Promise.resolve({ ...event, snapshot: null });
  return request.then(
    (snapshot) => ({ ...event, snapshot }),
    (error) => ({ ...event, snapshot: null, snapshotError: snapshotError(error) }),
  );
}
