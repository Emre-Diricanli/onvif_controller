// spring.js — requestAnimationFrame spring engine.
//
// Apple parameterisation: a spring is described by a damping RATIO (1.0 =
// critically damped, < 1 bounces) and a RESPONSE in seconds (roughly the time
// it takes to reach the target), never by mass/stiffness.
//
// The engine always animates from the current presentation value, and
// re-targeting mid-flight carries the current velocity through, so there is
// never a visible cut.

export const SPRING_DEFAULTS = { damping: 1.0, response: 0.35 };

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export function prefersReducedMotion() {
  return reducedMotionQuery.matches;
}

export function onReducedMotionChange(cb) {
  const handler = (e) => cb(e.matches);
  reducedMotionQuery.addEventListener('change', handler);
  return () => reducedMotionQuery.removeEventListener('change', handler);
}

/**
 * Momentum projection: where does a flick come to rest?
 * (v/1000) * d / (1 - d) — velocity in px/s, result in px.
 */
export function project(velocity, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/**
 * Progressive resistance past a limit. `overshoot` is how far past the edge
 * the pointer is, `dimension` is the size of the constrained axis. Returns the
 * *resisted* overshoot — always smaller than the input, never a hard stop.
 */
export function rubberband(overshoot, dimension, constant = 0.55) {
  if (dimension === 0 || overshoot === 0) return 0;
  const d = Math.abs(overshoot);
  const resisted = (constant * d * Math.abs(dimension)) / (Math.abs(dimension) + constant * d);
  return Math.sign(overshoot) * resisted;
}

/**
 * @param {Object} opts
 * @param {number} opts.from        starting presentation value
 * @param {number} opts.to          target value
 * @param {number} [opts.velocity]  initial velocity, units/second
 * @param {number} [opts.damping]   damping ratio, default 1.0
 * @param {number} [opts.response]  response in seconds, default 0.35
 * @param {(value: number) => void} opts.onUpdate
 * @param {() => void} [opts.onComplete]  fired once each time the spring settles
 * @returns {{ setTarget: (value: number, carryVelocity?: boolean) => void,
 *             stop: () => void,
 *             getValue: () => number,
 *             getVelocity: () => number,
 *             getTarget: () => number,
 *             isAnimating: () => boolean }}
 */
export function spring({
  from = 0,
  to = 0,
  velocity = 0,
  damping = SPRING_DEFAULTS.damping,
  response = SPRING_DEFAULTS.response,
  onUpdate,
  onComplete,
} = {}) {
  let value = from;
  let target = to;
  let v = velocity;
  let rafId = null;
  let lastTime = null;
  let completed = false;

  // mass = 1; stiffness/damping derived from damping ratio + response.
  const omega = (2 * Math.PI) / Math.max(response, 0.001);
  const stiffness = omega * omega;
  const dampingCoeff = 2 * damping * omega;

  const SETTLE_DISTANCE = 0.0005;
  const SETTLE_VELOCITY = 0.0005;

  function isSettled() {
    return Math.abs(value - target) < SETTLE_DISTANCE && Math.abs(v) < SETTLE_VELOCITY;
  }

  function finish() {
    value = target;
    v = 0;
    rafId = null;
    lastTime = null;
    if (onUpdate) onUpdate(value);
    if (onComplete && !completed) {
      completed = true;
      onComplete();
    }
  }

  function step(now) {
    if (lastTime == null) lastTime = now;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt <= 0) {
      rafId = requestAnimationFrame(step);
      return;
    }
    if (dt > 0.064) dt = 0.064; // tab was backgrounded — don't explode

    // Semi-implicit Euler at a fixed 240Hz sub-step: stable for any
    // damping/response combination regardless of display refresh rate.
    const subSteps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      const accel = -stiffness * (value - target) - dampingCoeff * v;
      v += accel * h;
      value += v * h;
    }

    if (isSettled()) {
      finish();
      return;
    }
    if (onUpdate) onUpdate(value);
    rafId = requestAnimationFrame(step);
  }

  function start() {
    if (rafId != null) return;
    completed = false;
    lastTime = null;
    rafId = requestAnimationFrame(step);
  }

  const handle = {
    /**
     * Re-target the spring. By default the current velocity carries through
     * (interruptible, no cut); pass carryVelocity=false to drop it.
     */
    setTarget(next, carryVelocity = true) {
      target = next;
      if (!carryVelocity) v = 0;
      if (rafId == null && isSettled()) {
        // Already resting at the new target — nothing to do, but keep the
        // completion contract consistent for callers waiting on it.
        completed = false;
        finish();
        return;
      }
      start();
    },
    stop() {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      lastTime = null;
    },
    getValue: () => value,
    getVelocity: () => v,
    getTarget: () => target,
    isAnimating: () => rafId != null,
  };

  if (!isSettled()) start();
  else completed = false;

  return handle;
}

/**
 * Convenience: spring a 2D point. Returns per-axis handles plus combined
 * helpers. Each axis is an independent spring sharing the same parameters.
 */
export function spring2D({ x = 0, y = 0, velocityX = 0, velocityY = 0, damping, response, onUpdate, onComplete } = {}) {
  let doneCount = 0;
  const done = () => {
    doneCount += 1;
    if (doneCount === 2 && onComplete) onComplete();
  };
  const sx = spring({ from: x, to: x, velocity: velocityX, damping, response, onComplete: done, onUpdate: () => emit() });
  const sy = spring({ from: y, to: y, velocity: velocityY, damping, response, onComplete: done, onUpdate: () => emit() });
  function emit() {
    if (onUpdate) onUpdate(sx.getValue(), sy.getValue());
  }
  return {
    setTarget(nx, ny, carryVelocity = true) {
      doneCount = 0;
      sx.setTarget(nx, carryVelocity);
      sy.setTarget(ny, carryVelocity);
    },
    stop() { sx.stop(); sy.stop(); },
    getX: () => sx.getValue(),
    getY: () => sy.getValue(),
    getVelocityX: () => sx.getVelocity(),
    getVelocityY: () => sy.getVelocity(),
  };
}
