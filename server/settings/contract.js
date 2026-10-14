/**
 * Shared write semantics for every adapter (ADAPTERS.md §3, §6).
 *
 * One implementation of "is this patch valid" and "did the device actually do
 * it", so that `applied` means the same thing on every protocol. Adapters call
 * validatePatch() before sending anything, and verifyWrite() after.
 */
import { AppError } from '../errors.js';

export const SCOPES = Object.freeze(['device', 'channel', 'source', 'stream']);
export const TYPES = Object.freeze(['int', 'number', 'enum', 'bool', 'string']);
export const GROUPS = Object.freeze(['imaging', 'encoder', 'osd', 'network', 'time', 'system', 'ptz', 'other']);
export const OUTCOMES = Object.freeze(['applied', 'adjusted', 'unchanged', 'rejected', 'unknown']);

/** Polled, not slept once: devices apply asynchronously (VENDOR.md, imaging.js). */
export const READBACK_DELAYS_MS = Object.freeze([150, 400, 900]);

export const CANONICAL_KEYS = Object.freeze([
  'image.brightness', 'image.contrast', 'image.saturation', 'image.sharpness',
  'image.dayNight', 'image.wdr', 'image.wdrLevel', 'image.blc',
  'image.mirror', 'image.flip', 'image.irLight',
  'video.codec', 'video.resolution', 'video.fps', 'video.bitrateMode',
  'video.bitrate', 'video.gop', 'video.profile',
]);

/** A key is canonical, or namespaced to the adapter that declared it. */
export function isValidKey(key, adapterId) {
  if (CANONICAL_KEYS.includes(key)) return true;
  return typeof key === 'string' && key.startsWith(`vendor.${adapterId}.`) && key.length > `vendor.${adapterId}.`.length;
}

/** Returns a list of problems; empty means the descriptor honours §3. */
export function descriptorProblems(d, adapterId) {
  const problems = [];
  if (!d || typeof d !== 'object') return ['descriptor is not an object'];
  if (!isValidKey(d.key, adapterId)) problems.push(`key "${d.key}" is neither canonical nor vendor.${adapterId}.*`);
  if (!TYPES.includes(d.type)) problems.push(`${d.key}: type "${d.type}" is not one of ${TYPES.join('|')}`);
  if (!GROUPS.includes(d.group)) problems.push(`${d.key}: group "${d.group}" is not one of ${GROUPS.join('|')}`);
  if (typeof d.writable !== 'boolean') problems.push(`${d.key}: writable must be boolean`);
  if (typeof d.resource !== 'string' || !d.resource) problems.push(`${d.key}: resource is required`);
  if (typeof d.label !== 'string' || !d.label) problems.push(`${d.key}: label is required`);
  if (d.type === 'enum' && (!Array.isArray(d.values) || d.values.length === 0)) problems.push(`${d.key}: enum needs values`);
  if (d.min !== undefined && d.max !== undefined && !(Number(d.min) <= Number(d.max))) problems.push(`${d.key}: min > max`);
  return problems;
}

function typeMatches(d, value) {
  switch (d.type) {
    case 'int': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'bool': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && d.values.includes(value);
    case 'string': return typeof value === 'string';
    default: return false;
  }
}

/**
 * Throws BAD_REQUEST before anything reaches the wire. Returns the descriptors
 * for the patched keys, keyed by key, for the caller's convenience.
 */
export function validatePatch(patch, descriptors) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new AppError('BAD_REQUEST', 'A non-empty settings object is required.');
  }
  const byKey = new Map(descriptors.map((d) => [d.key, d]));
  const used = {};
  for (const [key, value] of Object.entries(patch)) {
    const d = byKey.get(key);
    if (!d) throw new AppError('BAD_REQUEST', `This target has no setting "${key}".`);
    if (!d.writable) throw new AppError('BAD_REQUEST', `"${key}" is read-only on this device.`);
    if (!typeMatches(d, value)) {
      const allowed = d.type === 'enum' ? ` (one of ${d.values.join(', ')})` : '';
      throw new AppError('BAD_REQUEST', `"${key}" must be a ${d.type}${allowed}.`);
    }
    if ((d.type === 'int' || d.type === 'number')
      && ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max))) {
      throw new AppError('BAD_REQUEST', `"${key}" must be between ${d.min ?? '-∞'} and ${d.max ?? '∞'}.`);
    }
    used[key] = d;
  }
  return used;
}

/** Equality the way an operator means it: within half a step for numbers. */
export function sameValue(a, b, d = null) {
  if (a === undefined || a === null || b === undefined || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    const tolerance = d?.step ? d.step / 2 : 1e-9;
    return Math.abs(a - b) < tolerance || a === b;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  return String(a) === String(b);
}

export function classify({ requested, before, observed, descriptor = null }) {
  if (observed === undefined) return 'unknown';
  if (sameValue(observed, requested, descriptor)) return 'applied';
  if (sameValue(observed, before, descriptor)) return 'unchanged';
  return 'adjusted';
}

/**
 * Poll the read-back until every field is applied or the schedule runs out.
 *
 *   before     values of the patched keys prior to the write
 *   readBack   async () => values object (may contain more keys)
 *   rejected   keys the device explicitly refused; they are not polled
 *   delays     override for tests only
 *
 * A read-back that throws on every attempt yields `unknown`, never `applied`.
 */
export async function verifyWrite({ patch, before, readBack, descriptors = {}, rejected = [], source, delays = READBACK_DELAYS_MS }) {
  const keys = Object.keys(patch).filter((k) => !rejected.includes(k));
  let observed = null;
  for (const ms of delays) {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    try {
      observed = await readBack();
    } catch {
      continue;
    }
    const done = keys.every((k) => classify({
      requested: patch[k], before: before?.[k], observed: observed?.[k], descriptor: descriptors[k],
    }) === 'applied');
    if (done) break;
  }
  const results = {};
  const values = {};
  for (const [key, requested] of Object.entries(patch)) {
    if (rejected.includes(key)) {
      results[key] = { outcome: 'rejected', requested, observed: observed?.[key] ?? before?.[key] };
      continue;
    }
    const value = observed ? observed[key] : undefined;
    results[key] = {
      outcome: classify({ requested, before: before?.[key], observed: value, descriptor: descriptors[key] }),
      requested,
      observed: value,
    };
    if (value !== undefined) values[key] = value;
  }
  return { source, results, values };
}

/** The kernel's stub rule (§6): every field ignored after the full schedule. */
export function allUnchanged(writeResult) {
  const outcomes = Object.values(writeResult?.results ?? {}).map((r) => r.outcome);
  return outcomes.length > 0 && outcomes.every((o) => o === 'unchanged');
}
