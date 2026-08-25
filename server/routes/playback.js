import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireSession } from '../sessions.js';
import { probePlayback } from '../onvif/playback.js';
import { redactUri } from '../onvif/util.js';

const router = Router({ mergeParams: true });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function dateParam(value, name) {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new AppError('BAD_REQUEST', `"${name}" must be a valid date and time.`);
  }
  return date.toISOString();
}

function redactText(value) {
  return value.replace(/\b(?:https?|rtsp):\/\/[^\s"'<>]+/gi, (uri) => redactUri(uri) ?? '[redacted URI]');
}

function sanitize(value, key = '') {
  if (/searchToken/i.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
      const clean = sanitize(entryValue, entryKey);
      return clean === undefined ? [] : [[entryKey, clean]];
    }));
  }
  if (typeof value !== 'string') return value;
  if (/uri|url|xaddr/i.test(key)) return redactUri(value);
  return redactText(value);
}

router.get('/playback', wrap(async (req, res) => {
  const session = requireSession(req.params.id);
  const from = dateParam(req.query?.from, 'from');
  const to = dateParam(req.query?.to, 'to');
  if (from && to && new Date(from) > new Date(to)) {
    throw new AppError('BAD_REQUEST', '"from" must be earlier than or equal to "to".');
  }

  // probePlayback applies session.timeoutMs to every device call and retains
  // its read-only SOAP guard, including Search cleanup on failure paths.
  const report = await probePlayback(session, { from, to });
  res.set('Cache-Control', 'no-store');
  res.json(sanitize(report));
}));

export default router;
