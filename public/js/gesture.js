// gesture.js — Pointer Events helpers built on setPointerCapture.
//
// Everything here responds on pointerdown, tracks 1:1 (respecting the grab
// offset — nothing ever snaps to the element center), keeps the last ~5
// pointer samples to compute release velocity, and requires ~10px of travel
// (hysteresis) before a drag commits to a direction.

import { spring, prefersReducedMotion } from './spring.js';

export const VELOCITY_SAMPLE_COUNT = 5;
export const DEFAULT_HYSTERESIS = 10;

/** Rolling window of pointer samples used to estimate release velocity. */
export class VelocityTracker {
  constructor(maxSamples = VELOCITY_SAMPLE_COUNT) {
    this.maxSamples = maxSamples;
    this.samples = [];
  }

  add(x, y, t = performance.now()) {
    this.samples.push({ x, y, t });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  reset() {
    this.samples.length = 0;
  }

  /** Velocity in px/second over the sampled window. */
  velocity() {
    if (this.samples.length < 2) return { x: 0, y: 0 };
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return { x: 0, y: 0 };
    return {
      x: ((last.x - first.x) / dt) * 1000,
      y: ((last.y - first.y) / dt) * 1000,
    };
  }
}

/**
 * Make an element draggable with pointer capture.
 *
 * @param {HTMLElement} el
 * @param {Object} opts
 * @param {number} [opts.hysteresis=10] px of travel before the drag commits
 * @param {'any'|'x'|'y'} [opts.axis='any'] constrain the committed direction
 * @param {(info) => void} [opts.onStart]  pointerdown, before any travel
 * @param {(info) => void} [opts.onMove]   continuous position while dragging;
 *        info = { x, y, dx, dy, startX, startY, direction, velocity, event }
 * @param {(info) => void} [opts.onEnd]    pointerup;
 *        info = { committed, direction, velocity, x, y, dx, dy, event }
 * @param {(info) => void} [opts.onCancel] pointercancel
 * @returns {() => void} teardown — removes all listeners
 */
export function draggable(el, { hysteresis = DEFAULT_HYSTERESIS, axis = 'any', onStart, onMove, onEnd, onCancel } = {}) {
  function handleDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const tracker = new VelocityTracker();
    tracker.add(startX, startY);
    let committed = false;
    let direction = axis !== 'any' ? axis : null;

    if (onStart) onStart({ x: startX, y: startY, event: e });

    function handleMove(ev) {
      if (ev.pointerId !== e.pointerId) return;
      tracker.add(ev.clientX, ev.clientY);
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!committed) {
        if (Math.hypot(dx, dy) < hysteresis) return;
        committed = true;
        if (direction == null) direction = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      if (onMove) {
        onMove({
          x: ev.clientX,
          y: ev.clientY,
          dx,
          dy,
          startX,
          startY,
          direction,
          velocity: tracker.velocity(),
          event: ev,
        });
      }
    }

    function handleUp(ev) {
      if (ev.pointerId !== e.pointerId) return;
      tracker.add(ev.clientX, ev.clientY);
      cleanup();
      if (onEnd) {
        onEnd({
          committed,
          direction,
          velocity: tracker.velocity(),
          x: ev.clientX,
          y: ev.clientY,
          dx: ev.clientX - startX,
          dy: ev.clientY - startY,
          event: ev,
        });
      }
    }

    function handleCancel(ev) {
      if (ev.pointerId !== e.pointerId) return;
      cleanup();
      if (onCancel) onCancel({ event: ev });
    }

    function cleanup() {
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup', handleUp);
      el.removeEventListener('pointercancel', handleCancel);
      if (el.releasePointerCapture) {
        try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      }
    }

    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup', handleUp);
    el.addEventListener('pointercancel', handleCancel);
  }

  el.addEventListener('pointerdown', handleDown);
  return () => el.removeEventListener('pointerdown', handleDown);
}

/**
 * Press feedback: the element scales down slightly on pointerdown and springs
 * back on release. Feedback happens on pointerdown, never on click, and is
 * always interruptible — a quick tap still gets the full down-and-up.
 *
 * @param {HTMLElement} el
 * @param {Object} [opts]
 * @param {number} [opts.scale=0.96]
 * @returns {() => void} teardown
 */
export function pressable(el, { scale = 0.96 } = {}) {
  let pressSpring = null;
  let current = 1;

  function apply(v) {
    current = v;
    el.style.transform = `scale(${v})`;
  }

  function animateTo(target, damping) {
    if (prefersReducedMotion()) {
      apply(target);
      return;
    }
    if (!pressSpring) {
      pressSpring = spring({
        from: current,
        to: current,
        damping,
        response: 0.25,
        onUpdate: apply,
      });
    }
    pressSpring.setTarget(target, true);
  }

  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    animateTo(scale, 1.0);
  }
  function up() {
    animateTo(1, 1.0);
  }

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', up);
    if (pressSpring) pressSpring.stop();
    el.style.transform = '';
  };
}
