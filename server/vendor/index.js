/**
 * Vendor driver registry and the fallback decision.
 *
 * ONVIF is always the primary path. A vendor driver exists only for cameras
 * that accept an ONVIF write, answer with success, and change nothing — a
 * failure mode that is invisible unless you read the value back. See VENDOR.md.
 *
 * The rules this module enforces:
 *   - never probe a vendor driver until ONVIF has actually been caught lying
 *   - never apply a value the operator did not ask for
 *   - always report which path produced the result
 *   - if the vendor path fails, degrade to ONVIF's honest answer, never to a
 *     crash and never to a false claim of success
 */
import { AppError } from '../errors.js';
import * as vatilon from './vatilon.js';

/** Registration order is probe order. Cheapest and most specific first. */
const DRIVERS = [vatilon];

export const ONVIF_SOURCE = 'onvif';

/**
 * Did this ONVIF write get silently ignored?
 *
 * `applied` maps each patched field to whether the device reported the new
 * value on read-back. Every field failing means the service is a stub. A subset
 * failing usually means clamping or an unsupported field, which a vendor driver
 * would not fix — so only a total refusal counts.
 */
export function looksLikeOnvifStub(applied) {
  if (!applied || typeof applied !== 'object') return false;
  const values = Object.values(applied);
  return values.length > 0 && values.every((v) => v === false);
}

function driverStateFor(session) {
  if (!session.vendor) {
    session.vendor = { probed: false, driver: null, connection: null, failures: 0 };
  }
  return session.vendor;
}

const MAX_VENDOR_FAILURES = 3;

/**
 * Resolve a working vendor connection for this session, or null.
 *
 * Probing happens at most once per session. A driver that keeps failing is
 * abandoned rather than retried forever, so a flaky proprietary API cannot make
 * every slider drag slow.
 */
export async function getVendorConnection(session, { timeoutMs = 8000 } = {}) {
  const state = driverStateFor(session);

  if (state.connection) return state.connection;
  if (state.failures >= MAX_VENDOR_FAILURES) return null;
  if (state.probed && !state.driver) return null;

  const credentials = {
    host: session.host,
    port: 80,          // the proprietary UI is on plain HTTP, not the ONVIF port
    username: session.username,
    password: session.password,
    timeoutMs,
  };

  if (!state.probed) {
    state.probed = true;
    for (const driver of DRIVERS) {
      let matched = false;
      try {
        matched = await driver.probe(credentials);
      } catch {
        matched = false;   // a probe must never take down the request
      }
      if (matched) {
        state.driver = driver;
        break;
      }
    }
  }

  if (!state.driver) return null;

  try {
    state.connection = await state.driver.connect(credentials);
    return state.connection;
  } catch {
    state.failures += 1;
    state.connection = null;
    return null;
  }
}

/** Torn down with the session; a driver may hold a socket or a heartbeat timer. */
export function closeVendor(session) {
  const state = session.vendor;
  if (!state?.connection) return;
  try { state.connection.close(); } catch { /* already gone */ }
  state.connection = null;
}

export function vendorDriverId(session) {
  return session.vendor?.driver?.id ?? null;
}

export function vendorDriverLabel(session) {
  return session.vendor?.driver?.label ?? null;
}

/**
 * Attempt a write through the vendor path after ONVIF was seen to ignore it.
 *
 * Returns null when there is no usable driver, which the caller treats as
 * "keep ONVIF's honest answer" rather than as an error.
 */
export async function tryVendorWrite(session, patch) {
  const connection = await getVendorConnection(session);
  if (!connection) return null;

  try {
    const result = await connection.setImaging(patch);
    session.vendor.failures = 0;
    return { ...result, source: connection.id };
  } catch (err) {
    session.vendor.failures += 1;
    if (session.vendor.failures >= MAX_VENDOR_FAILURES) closeVendor(session);
    // Deliberately swallowed: the ONVIF result is still valid and truthful, and
    // a broken proprietary API must not turn a working app into an error page.
    if (!(err instanceof AppError)) return null;
    return null;
  }
}

/** Read through the vendor path, used once a driver owns the picture settings. */
export async function tryVendorRead(session) {
  const connection = await getVendorConnection(session);
  if (!connection) return null;
  try {
    const result = await connection.getImaging();
    return { ...result, source: connection.id };
  } catch {
    return null;
  }
}
