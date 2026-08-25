import { createHmac, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { AppError } from '../errors.js';
import {
  ensureTargetsLoaded, getTarget, redactedTargets, targetLoadErrors,
} from '../fanout/config.js';
import { getDeliveryStats } from '../fanout/delivery.js';

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const RESPONSE_PREVIEW_BYTES = 512;

function statsFor(id) {
  const stats = getDeliveryStats(id);
  return stats ? { ...stats } : null;
}

router.get('/fanout', wrap(async (_req, res) => {
  await ensureTargetsLoaded();
  res.json({
    enabled: Boolean(process.env.FANOUT_CONFIG),
    targets: redactedTargets().map((target) => ({ ...target, stats: statsFor(target.id) })),
    errors: targetLoadErrors(),
  });
}));

router.post('/fanout/test', wrap(async (req, res) => {
  const id = req.body?.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new AppError('BAD_REQUEST', 'A target id is required.');
  }
  await ensureTargetsLoaded();
  const target = getTarget(id.trim());
  if (!target) throw new AppError('NOT_FOUND', `Fan-out target "${id.trim()}" was not found.`);

  const eventId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: eventId,
    source: { host: 'fanout-test', port: 0, channel: 'test', label: 'Fan-out test', profile: 'test' },
    device: { manufacturer: 'Spacture', model: 'Fan-out test', serial: null },
    topic: 'spacture:Fanout/Test',
    class: 'other',
    state: true,
    eventTime: new Date(timestamp * 1000).toISOString(),
    receivedAt: new Date().toISOString(),
    data: { synthetic: true },
    snapshot: null,
  });
  const signature = createHmac('sha256', target.secret).update(body).digest('hex');
  const started = performance.now();
  let response;
  try {
    response = await fetch(target.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(target.delivery.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'X-Onvif-Event-Id': eventId,
        'X-Onvif-Timestamp': String(timestamp),
        'X-Onvif-Signature': `sha256=${signature}`,
      },
      body,
    });
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    const detail = error?.cause?.message ?? error?.message ?? String(error);
    throw new AppError('DEVICE_UNREACHABLE', `The fan-out test connection failed: ${detail}`,
      `The request failed after ${elapsedMs} ms.`, 502);
  }

  const elapsedMs = Math.round(performance.now() - started);
  const bytes = Buffer.from(await response.arrayBuffer());
  res.json({
    targetId: target.id,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    elapsedMs,
    response: bytes.subarray(0, RESPONSE_PREVIEW_BYTES).toString('utf8'),
    responseTruncated: bytes.length > RESPONSE_PREVIEW_BYTES,
  });
}));

export default router;
