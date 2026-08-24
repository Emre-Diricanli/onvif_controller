import { AppError } from '../errors.js';

/**
 * How long a continuous move may run without a fresh keepalive before the
 * server stops it on its own.
 *
 * The joystick re-sends a move every ~100ms while held, so silence for well
 * over a second means the client is gone: the tab was closed or backgrounded,
 * the laptop slept, or the network dropped. Without this, the camera keeps
 * panning until it hits a mechanical limit — the browser is simply not a
 * trustworthy place to put the only stop signal.
 */
const MOVE_KEEPALIVE_MS = 1500;
import { callCam, tryCam, asArray, num, normalized, speed01, toDeviceRange, fromDeviceRange } from './util.js';

function readSpace(space, fallbackMin, fallbackMax) {
  const range = space?.XRange ?? space?.xRange ?? null;
  return {
    min: num(range?.min, fallbackMin),
    max: num(range?.max, fallbackMax),
  };
}

/**
 * Probe the PTZ node. Returns null when the service exists but nothing is
 * actually movable — a fixed dome on a PTZ-capable firmware. Callers use null to
 * hide the whole PTZ surface rather than render dead controls.
 */
export async function readPtzCapabilities(cam, profiles, ctx) {
  const nodes = asArray(await tryCam(cam, 'getNodes', undefined, null, { ctx }));
  const node = nodes.find((n) => n && (n.supportedPTZSpaces || n.$?.token)) ?? nodes[0] ?? null;
  const anyProfilePtz = profiles.some((p) => p.ptzSupported);

  if (!node && !anyProfilePtz) return null;

  const spaces = node?.supportedPTZSpaces ?? {};
  const panTiltSpace = asArray(spaces.continuousPanTiltVelocitySpace)[0]
    ?? asArray(spaces.absolutePanTiltPositionSpace)[0] ?? null;
  const zoomSpace = asArray(spaces.continuousZoomVelocitySpace)[0]
    ?? asArray(spaces.absoluteZoomPositionSpace)[0] ?? null;

  const panTiltX = readSpace(panTiltSpace, -1, 1);
  const yRange = panTiltSpace?.YRange ?? panTiltSpace?.yRange ?? null;
  const zoom = readSpace(zoomSpace, 0, 1);

  const hasMotion = Boolean(panTiltSpace || zoomSpace || anyProfilePtz);
  if (!hasMotion) return null;

  return {
    nodeToken: node?.$?.token ?? null,
    spaces: {
      panTilt: {
        xMin: panTiltX.min, xMax: panTiltX.max,
        yMin: num(yRange?.min, -1), yMax: num(yRange?.max, 1),
      },
      zoom: { min: zoom.min, max: zoom.max },
    },
    presetsSupported: num(node?.maximumNumberOfPresets, 0) > 0 || node === null || anyProfilePtz,
    maximumPresets: num(node?.maximumNumberOfPresets, null),
    toursSupported: Boolean(node?.extension?.supportedPresetTour),
    homeSupported: Boolean(node?.homeSupported ?? true),
    auxCommands: asArray(node?.auxiliaryCommands).map(String).filter(Boolean),
  };
}

function velocity(session, { pan, tilt, zoom }) {
  const spaces = session.ptz?.spaces;
  const out = {};
  if (pan !== 0 || tilt !== 0) {
    out.x = toDeviceRange(pan, { min: spaces?.panTilt?.xMin ?? -1, max: spaces?.panTilt?.xMax ?? 1 });
    out.y = toDeviceRange(tilt, { min: spaces?.panTilt?.yMin ?? -1, max: spaces?.panTilt?.yMax ?? 1 });
  }
  if (zoom !== 0) {
    out.zoom = toDeviceRange(zoom, { min: spaces?.zoom?.min ?? -1, max: spaces?.zoom?.max ?? 1 });
  }
  return out;
}

function requirePtz(session) {
  if (!session.ptz) {
    throw new AppError('UNSUPPORTED', 'This device does not support PTZ.');
  }
}

/**
 * The joystick sends a move every ~100ms while held. ONVIF devices are slow and
 * will happily accumulate a request backlog that keeps the camera moving after
 * release. Keep at most one in-flight move plus one pending, and drop the rest.
 */
async function coalescedMove(session, profileToken, run) {
  const key = `ptz:${profileToken}`;
  const state = session.inflight.get(key) ?? { running: false, pending: null };
  session.inflight.set(key, state);

  if (state.running) {
    state.pending = run; // newest wins; older intermediate positions are stale
    return;
  }

  state.running = true;
  try {
    await run();
  } finally {
    state.running = false;
    const next = state.pending;
    state.pending = null;
    if (next) coalescedMove(session, profileToken, next).catch(() => {});
  }
}

/** Cancel any armed dead-man timer for this session. */
export function disarmMoveWatchdog(session) {
  if (session.ptzWatchdog) {
    clearTimeout(session.ptzWatchdog);
    session.ptzWatchdog = null;
  }
}

function armMoveWatchdog(session, profileToken) {
  disarmMoveWatchdog(session);
  session.ptzWatchdog = setTimeout(() => {
    session.ptzWatchdog = null;
    // Best effort: the client is already gone, so there is nobody to report to.
    stopMove(session, { profileToken, panTilt: true, zoom: true }).catch(() => {});
  }, MOVE_KEEPALIVE_MS);
  session.ptzWatchdog.unref?.();
}

export async function continuousMove(session, { profileToken, pan, tilt, zoom }) {
  requirePtz(session);
  const p = normalized(pan, 'pan');
  const t = normalized(tilt, 'tilt');
  const z = normalized(zoom, 'zoom');

  await coalescedMove(session, profileToken, async () => {
    if (p === 0 && t === 0 && z === 0) {
      await stopMove(session, { profileToken, panTilt: true, zoom: true });
      return;
    }
    armMoveWatchdog(session, profileToken);
    await callCam(session.cam, 'continuousMove', {
      profileToken,
      ...velocity(session, { pan: p, tilt: t, zoom: z }),
      // No timeout: the client is responsible for sending stop. A timeout here
      // makes the camera stutter whenever a keepalive move is a few ms late.
    }, { ctx: session.ctx });
  });
}

export async function stopMove(session, { profileToken, panTilt = true, zoom = true }) {
  requirePtz(session);
  disarmMoveWatchdog(session);
  try {
    await callCam(session.cam, 'stop', { profileToken, panTilt, zoom }, { ctx: session.ctx });
  } catch (err) {
    // Stop must be idempotent: a device that was not moving may fault, and that
    // is not an error the operator needs to see.
    if (err?.code === 'UNSUPPORTED' || err?.code === 'DEVICE_ERROR') return;
    throw err;
  }
}

export async function relativeMove(session, { profileToken, pan, tilt, zoom, speed }) {
  requirePtz(session);
  await callCam(session.cam, 'relativeMove', {
    profileToken,
    x: normalized(pan, 'pan'),
    y: normalized(tilt, 'tilt'),
    zoom: normalized(zoom, 'zoom'),
    speed: speed01(speed),
  }, { ctx: session.ctx });
}

export async function absoluteMove(session, { profileToken, pan, tilt, zoom, speed }) {
  requirePtz(session);
  await callCam(session.cam, 'absoluteMove', {
    profileToken,
    x: normalized(pan, 'pan'),
    y: normalized(tilt, 'tilt'),
    zoom: normalized(zoom, 'zoom'),
    speed: speed01(speed),
  }, { ctx: session.ctx });
}

export async function getStatus(session, profileToken) {
  requirePtz(session);
  const status = await callCam(session.cam, 'getStatus', { profileToken }, { ctx: session.ctx });
  const spaces = session.ptz?.spaces;
  const pos = status?.position ?? {};
  return {
    position: {
      pan: fromDeviceRange(num(pos.x, 0), { min: spaces?.panTilt?.xMin ?? -1, max: spaces?.panTilt?.xMax ?? 1 }),
      tilt: fromDeviceRange(num(pos.y, 0), { min: spaces?.panTilt?.yMin ?? -1, max: spaces?.panTilt?.yMax ?? 1 }),
      zoom: fromDeviceRange(num(pos.zoom, 0), { min: spaces?.zoom?.min ?? 0, max: spaces?.zoom?.max ?? 1 }),
    },
    moving: String(status?.moveStatus?.panTilt ?? 'IDLE').toUpperCase() !== 'IDLE'
      || String(status?.moveStatus?.zoom ?? 'IDLE').toUpperCase() !== 'IDLE',
    utcTime: status?.utcTime instanceof Date ? status.utcTime.toISOString() : null,
  };
}

export async function getPresets(session, profileToken) {
  requirePtz(session);
  const raw = await callCam(session.cam, 'getPresets', { profileToken }, { ctx: session.ctx });
  const spaces = session.ptz?.spaces;

  // The library returns a { name: token } map for some devices and an array for
  // others. Normalize both into the API.md shape.
  const entries = Array.isArray(raw)
    ? raw.map((p) => [p?.name ?? p?.$?.token, p?.$?.token ?? p?.token, p?.PTZPosition])
    : Object.entries(raw ?? {}).map(([name, token]) => [name, token, null]);

  return entries
    .filter(([, token]) => token !== undefined && token !== null)
    .map(([name, token, position]) => ({
      token: String(token),
      name: String(name ?? token),
      position: position
        ? {
            pan: fromDeviceRange(num(position.panTilt?.x, 0), { min: spaces?.panTilt?.xMin ?? -1, max: spaces?.panTilt?.xMax ?? 1 }),
            tilt: fromDeviceRange(num(position.panTilt?.y, 0), { min: spaces?.panTilt?.yMin ?? -1, max: spaces?.panTilt?.yMax ?? 1 }),
            zoom: fromDeviceRange(num(position.zoom?.x, 0), { min: spaces?.zoom?.min ?? 0, max: spaces?.zoom?.max ?? 1 }),
          }
        : null,
    }));
}

export async function gotoPreset(session, { profileToken, token, speed }) {
  requirePtz(session);
  const s = speed01(speed);
  await callCam(session.cam, 'gotoPreset', {
    profileToken,
    preset: String(token),
    speed: { x: s, y: s, zoom: s },
  }, { ctx: session.ctx });
}

export async function savePreset(session, { profileToken, name, token }) {
  requirePtz(session);
  const options = { profileToken, presetName: String(name ?? '').slice(0, 64) };
  if (token) options.presetToken = String(token);
  const res = await callCam(session.cam, 'setPreset', options, { ctx: session.ctx });
  return { token: String(res?.presetToken ?? token ?? ''), name: options.presetName };
}

export async function removePreset(session, { profileToken, token }) {
  requirePtz(session);
  await callCam(session.cam, 'removePreset', {
    profileToken, presetToken: String(token),
  }, { ctx: session.ctx });
}

export async function home(session, { profileToken, action }) {
  requirePtz(session);
  if (action === 'set') {
    await callCam(session.cam, 'setHomePosition', { profileToken }, { ctx: session.ctx });
    return;
  }
  await callCam(session.cam, 'gotoHomePosition', { profileToken, speed: 0.5 }, { ctx: session.ctx });
}

export async function auxiliary(session, { profileToken, command }) {
  requirePtz(session);
  if (typeof command !== 'string' || !command.trim()) {
    throw new AppError('BAD_REQUEST', 'An auxiliary command string is required.');
  }
  await callCam(session.cam, 'sendAuxiliaryCommand', {
    profileToken, auxiliaryData: command,
  }, { ctx: session.ctx });
}
