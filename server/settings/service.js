/**
 * The settings kernel: one API over every adapter (ADAPTERS.md §6, §9).
 *
 * A session has a primary connection: the ONVIF adapter wrapping the ONVIF
 * session, or a vendor adapter for a vendor-only session. The kernel owns the
 * one automatic cross-adapter decision the contract allows: when a write
 * through ONVIF came back with EVERY field unchanged after the full read-back
 * schedule (the stub signature), it may retry that write once through a
 * vendor adapter that answers on the same host, provided the target maps
 * unambiguously. Never after a timeout, a transport error, or `unknown`: the
 * first write might still land, and replaying it would be a double write.
 */
import { AppError } from '../errors.js';
import { allUnchanged } from './contract.js';
import { probeAll, getAdapter } from '../adapters/index.js';
import * as onvifAdapter from '../adapters/onvif/index.js';
import { reconfigureStreams, willDisruptStream, isDisruptiveChange } from '../stream/reconfigure.js';
import { refreshProfiles } from '../onvif/media.js';

/** The proprietary web API usually lives on port 80, not the ONVIF port. */
function vendorHttpPort(session) {
  return Number(session.httpPort ?? process.env.VENDOR_HTTP_PORT ?? 80);
}

export function primaryConnection(session) {
  if (session.connection) return session.connection;
  if (!session.cam) throw new AppError('UNSUPPORTED', 'This session has no settings connection.');
  session.connection = onvifAdapter.fromSession(session);
  return session.connection;
}

/**
 * Which connection answers for a target. A target an earlier stub fallback
 * moved to a vendor adapter stays there: once ONVIF was caught ignoring
 * writes, its read-back is stale fiction (VENDOR.md).
 */
function routeFor(session, targetId) {
  const moved = session.settingsFallback?.get(targetId);
  if (moved) return moved;
  return { connection: primaryConnection(session), targetId };
}

export async function listTargets(session) {
  return primaryConnection(session).listTargets();
}

export async function describeSettings(session, targetId) {
  const route = routeFor(session, targetId);
  const descriptors = await route.connection.describeSettings(route.targetId);
  return { target: targetId, source: route.connection.id, descriptors };
}

export async function readSettings(session, targetId, keys) {
  const route = routeFor(session, targetId);
  const result = await route.connection.read(route.targetId, keys);
  return { target: targetId, ...result };
}

/**
 * Find a vendor adapter that can take over a stubbed ONVIF target. Only for
 * a device with exactly one ONVIF source and exactly one vendor target of the
 * same kind: with several channels, matching "ONVIF source 2" to "vendor
 * channel 2" would be a guess, and a wrong guess writes to the wrong camera.
 */
async function findFallback(session, targetId, keys) {
  if (!targetId.startsWith('source:')) return null;
  const sources = (session.sources ?? []).filter((s) => s.token);
  if (sources.length !== 1) return null;

  const cfg = {
    host: session.host,
    port: vendorHttpPort(session),
    username: session.username,
    password: session.password,
    timeoutMs: 4000,
  };
  const probes = await probeAll(cfg);
  for (const probe of probes) {
    if (!probe.match || probe.id === onvifAdapter.id) continue;
    const adapter = await getAdapter(probe.id);
    let connection = null;
    try {
      connection = await adapter.connect(cfg);
      const candidates = (await connection.listTargets()).filter((t) => t.scope === 'channel' || t.scope === 'source');
      if (candidates.length !== 1) { connection.close(); continue; }
      const descriptors = await connection.describeSettings(candidates[0].id);
      const writable = new Set(descriptors.filter((d) => d.writable).map((d) => d.key));
      if (!keys.every((k) => writable.has(k))) { connection.close(); continue; }
      return { connection, targetId: candidates[0].id };
    } catch {
      try { connection?.close(); } catch { /* ignore */ }
    }
  }
  return null;
}

export async function writeSettings(session, targetId, patch) {
  const route = routeFor(session, targetId);
  const isOnvifStream = route.connection.id === onvifAdapter.id && targetId.startsWith('stream:');
  const profileToken = isOnvifStream ? targetId.slice('stream:'.length) : null;
  const disruptive = isOnvifStream
    && Object.keys(patch).some((k) => k === 'video.codec' || k === 'video.resolution')
    && willDisruptStream(session.id, profileToken);

  const result = await route.connection.write(route.targetId, patch);

  // ONVIF said yes to every field and changed none of them. That is the stub
  // signature, and the only point at which another protocol is worth trying.
  if (route.connection.id === onvifAdapter.id && allUnchanged(result) && !session.settingsFallback?.has(targetId)) {
    const fallback = await findFallback(session, targetId, Object.keys(patch));
    if (fallback) {
      const vendorResult = await fallback.connection.write(fallback.targetId, patch);
      if (!allUnchanged(vendorResult)) {
        session.settingsFallback ??= new Map();
        session.settingsFallback.set(targetId, fallback);
        return { target: targetId, ...vendorResult, fallbackFrom: onvifAdapter.id };
      }
      fallback.connection.close();
    }
  }

  const { encoderPatch, ...rest } = result;
  const out = { target: targetId, ...rest };
  if (isOnvifStream) {
    // The live pipeline and the cached profiles still describe the old
    // geometry; same bookkeeping as PATCH /encoder.
    out.streamRestartRequired = disruptive;
    out.streamsRestarted = isDisruptiveChange(encoderPatch) ? reconfigureStreams(session.id, profileToken, encoderPatch) : 0;
    try { await refreshProfiles(session); } catch { /* keep the stale cache */ }
  }
  return out;
}

/** Teardown hook: every connection this session opened. */
export function closeSettings(session) {
  for (const route of session.settingsFallback?.values() ?? []) {
    try { route.connection.close(); } catch { /* already gone */ }
  }
  session.settingsFallback?.clear();
  try { session.connection?.close(); } catch { /* already gone */ }
  session.connection = null;
}
