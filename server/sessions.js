import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { AppError } from './errors.js';
import { attachEvents } from './onvif/events.js';
import { stopMove, disarmMoveWatchdog, movingProfiles } from './onvif/ptz.js';
import { closeVendor } from './vendor/index.js';

/** In-memory only. Credentials must never reach disk. */
const sessions = new Map();
const destroyHandlers = new Set();
const createHandlers = new Set();

export function onSessionDestroyed(handler) {
  destroyHandlers.add(handler);
  return () => destroyHandlers.delete(handler);
}

/**
 * Observe new sessions. Optional features (fan-out) subscribe here rather than
 * being imported into this module, so the session store stays unaware of them
 * and a broken feature cannot prevent a session from being created.
 */
export function onSessionCreated(handler) {
  createHandlers.add(handler);
  return () => createHandlers.delete(handler);
}

export function createSession({ host, port, username, password, cam, device, capabilities, profiles, profileMap, sources, isMultiChannel, ptz }) {
  const id = randomUUID();
  const session = {
    id,
    host,
    port,
    username,
    password,
    cam,
    device,
    capabilities,
    profiles,
    profileMap,
    sources,
    isMultiChannel,
    ptz,
    ctx: { host, port },
    timeoutMs: config.onvifTimeoutMs,
    inflight: new Map(),
    events: new EventEmitter(),
    eventsAttached: false,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    touch() { this.lastSeenAt = Date.now(); },
  };

  if (capabilities.events) {
    try {
      session.events = attachEvents(session);
    } catch {
      // A device that advertises Events but cannot subscribe should still be
      // fully usable for streaming and PTZ.
      session.capabilities.events = false;
    }
  }

  sessions.set(id, session);

  for (const handler of createHandlers) {
    try { handler(session); } catch { /* an observer must never fail a connect */ }
  }

  return session;
}

export function getSession(id) {
  const session = sessions.get(id);
  if (session) session.touch();
  return session;
}

/** Route helper: resolve or throw the SESSION_EXPIRED envelope. */
export function requireSession(id) {
  const session = getSession(id);
  if (!session) {
    throw new AppError('SESSION_EXPIRED', 'That session is no longer active.',
      'Sessions end after 30 minutes idle or when the server restarts. Reconnect to the camera to continue.');
  }
  return session;
}

/** Resolve a profile token, defaulting to the first profile when omitted. */
export function requireProfile(session, token) {
  if ((token === undefined || token === null) && session.isMultiChannel) {
    throw new AppError('BAD_REQUEST', 'A profile is required to select a channel on this multi-channel device.');
  }
  const resolved = token ?? session.profiles[0]?.token;
  if (!resolved || !session.profileMap.has(resolved)) {
    throw new AppError('BAD_REQUEST', `Unknown profile "${token ?? '(none)'}".`);
  }
  return resolved;
}

export function destroySession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);

  for (const handler of destroyHandlers) {
    try { handler(id); } catch { /* one bad listener must not block teardown */ }
  }

  // Never leave a camera panning. Teardown happens on disconnect, on idle
  // expiry, and on shutdown — in every one of those cases the operator is gone
  // and any in-flight continuous move would otherwise run to a hard limit.
  disarmMoveWatchdog(session);
  if (session.ptz && session.cam) {
    // Stop EVERY channel that was moving, not just the first profile. On a
    // 32-channel recorder an operator moving channel 7 previously lost the
    // watchdog while Stop went to channel 1 — leaving channel 7 panning with
    // no backstop at all.
    const moving = movingProfiles(session);
    // Fall back to the first profile only when nothing was tracked, so a
    // single-camera session behaves exactly as it always has.
    const targets = moving.length > 0
      ? moving
      : [session.profiles?.[0]?.token].filter(Boolean);
    for (const profileToken of targets) {
      // Fire and forget: the caller is tearing down and cannot await this, and
      // a camera that has already gone offline must not block the teardown.
      stopMove(session, { profileToken, panTilt: true, zoom: true }).catch(() => {});
    }
  }
  // A vendor driver may hold a socket and a session heartbeat timer.
  try { closeVendor(session); } catch { /* already gone */ }
  try { session.events?.detach?.(); } catch { /* ignore */ }
  try { session.cam?.removeAllListeners?.(); } catch { /* ignore */ }

  session.password = null;
  session.cam = null;
  session.profileMap?.clear?.();
  return true;
}

/** Client-safe view. Deliberately omits password, cam, and every RTSP URI. */
export function serializeSession(session, { includeId = false } = {}) {
  return {
    ...(includeId ? { sessionId: session.id } : {}),
    device: session.device,
    capabilities: session.capabilities,
    profiles: session.profiles,
    sources: session.sources,
    isMultiChannel: session.isMultiChannel,
    ptz: session.ptz,
  };
}

const reaper = setInterval(() => {
  const cutoff = Date.now() - config.sessionIdleMs;
  for (const [id, session] of sessions) {
    if (session.lastSeenAt < cutoff) destroySession(id);
  }
}, 60_000);
reaper.unref();

export function shutdownAllSessions() {
  for (const id of [...sessions.keys()]) destroySession(id);
}
