// views/joystick.js — the analog PTZ pad.
//
// One continuous pad, not eight buttons. Drag tracks 1:1 with the pointer
// (respecting the grab offset); the offset vector maps to normalized
// pan/tilt in -1..1 and is POSTed at most every 100ms while held. The radius
// limit rubber-bands instead of hard-clamping. On release the knob springs
// home carrying the release velocity (bounce allowed — this is a momentum
// gesture) and the camera is told to stop. A separate rocker drives zoom.
// Focus and iris controls render only when the Imaging service exposes them.

import { api, ApiError } from '../api.js';
import { spring, rubberband, prefersReducedMotion } from '../spring.js';
import { draggable, pressable } from '../gesture.js';
import { onPageInactive } from '../player.js';

const MOVE_INTERVAL_MS = 100;

// Arrow keys drive the pad; these and +/- drive the rocker. Keyboard release
// carries no pointer velocity, so keyboard returns are critically damped —
// bounce is reserved for momentum gestures (SPEC.md §6).
const PAD_KEY_DIRS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};
const ROCKER_KEY_DIRS = {
  '+': 1, '=': 1, '-': -1, '_': -1,
  ArrowUp: 1, ArrowDown: -1,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function prettyAux(command) {
  // "tt:Wiper|On" → "Wiper On"
  return command.replace(/^tt:/, '').replace('|', ' ');
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, profile: string, ptz: object, onError: (err: ApiError) => void }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function renderJoystick(container, { sessionId, profile, ptz, onError }) {
  const cleanups = [];
  let destroyed = false;

  const wrap = el('div', 'joystick');

  // Current command vector sent to the camera (normalized -1..1).
  const vector = { pan: 0, tilt: 0, zoom: 0 };
  let moveFailed = false;
  let lastSentAt = 0;
  let trailingTimer = null;

  function reportError(err) {
    if (destroyed) return;
    if (err instanceof ApiError) onError(err);
  }

  function sendMove() {
    if (destroyed || moveFailed) return;
    lastSentAt = performance.now();
    api.ptzMove(sessionId, profile, vector).catch((err) => {
      // Optimistic UI is banned for the camera: a failed move stops the
      // stream of commands instead of letting the knob pretend.
      moveFailed = true;
      reportError(err);
    });
  }

  function scheduleMove() {
    if (destroyed || moveFailed) return;
    const elapsed = performance.now() - lastSentAt;
    if (elapsed >= MOVE_INTERVAL_MS) {
      sendMove();
    } else if (trailingTimer == null) {
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        sendMove();
      }, MOVE_INTERVAL_MS - elapsed);
    }
  }

  function stopAxes({ panTilt, zoom }) {
    if (panTilt) { vector.pan = 0; vector.tilt = 0; }
    if (zoom) vector.zoom = 0;
    if (destroyed) return;
    api.ptzStop(sessionId, profile, { panTilt, zoom }).catch(reportError);
  }

  // --- Page-inactivity safety watch ---
  //
  // If the operator backgrounds the tab, locks the screen, or the machine
  // sleeps while the pad or rocker is held (pointer OR keyboard), the
  // pointerup/keyup may never fire and the camera keeps driving until it hits
  // a mechanical limit. While any hold is active we subscribe to the player's
  // page-inactivity signal; when it fires we stop EVERY axis, cancel any
  // in-flight move, and reset both controls to centre. A camera left panning
  // is worse than any visual glitch — this path must be bulletproof.
  let unsubscribeInactive = null;
  let focusHolds = 0;
  const padKeys = new Set();
  const rockerKeys = new Set();

  function anyHoldActive() {
    return holding || rockerHolding || focusHolds > 0 || padKeys.size > 0 || rockerKeys.size > 0;
  }

  function updateSafetyWatch() {
    if (destroyed) return;
    if (anyHoldActive() && !unsubscribeInactive) {
      unsubscribeInactive = onPageInactive(handlePageInactive);
    } else if (!anyHoldActive() && unsubscribeInactive) {
      unsubscribeInactive();
      unsubscribeInactive = null;
    }
  }

  function handlePageInactive() {
    if (unsubscribeInactive) { unsubscribeInactive(); unsubscribeInactive = null; }
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
    holding = false;
    rockerHolding = false;
    padKeys.clear();
    rockerKeys.clear();
    pad.classList.remove('ptz-pad-active');
    rocker.classList.remove('zoom-rocker-active');
    stopReturnSprings();
    if (rockerSpring) { rockerSpring.stop(); rockerSpring = null; }
    vector.pan = 0; vector.tilt = 0; vector.zoom = 0;
    knobPos.x = 0; knobPos.y = 0; renderKnob();
    setRockerSilent(0);
    updateAria();
    if (focusHolds > 0) {
      focusHolds = 0;
      api.focus(sessionId, profile, 'stop').catch(() => {});
    }
    if (destroyed) return;
    api.ptzStop(sessionId, profile, { panTilt: true, zoom: true }).catch(reportError);
  }

  // --- Pad ---
  const pad = el('div', 'ptz-pad');
  pad.setAttribute('role', 'slider');
  pad.setAttribute('aria-label', 'Pan and tilt. Hold the arrow keys to move.');
  pad.setAttribute('aria-valuemin', '-100');
  pad.setAttribute('aria-valuemax', '100');
  pad.tabIndex = 0;
  const knob = el('div', 'ptz-knob');
  pad.appendChild(knob);

  const knobPos = { x: 0, y: 0 };
  let returnSpringX = null;
  let returnSpringY = null;
  let holding = false;

  function updateAria() {
    const mag = Math.round(Math.min(1, Math.hypot(vector.pan, vector.tilt)) * 100);
    pad.setAttribute('aria-valuenow', String(mag));
    pad.setAttribute('aria-valuetext', `pan ${vector.pan.toFixed(2)}, tilt ${vector.tilt.toFixed(2)}`);
    rocker.setAttribute('aria-valuenow', String(Math.round(rockerValue * 100)));
  }

  function padRadius() {
    return pad.clientWidth / 2;
  }
  function travelRadius() {
    return Math.max(0, padRadius() - knob.offsetWidth / 2);
  }

  function renderKnob() {
    knob.style.transform = `translate(-50%, -50%) translate(${knobPos.x}px, ${knobPos.y}px)`;
  }

  function stopReturnSprings() {
    if (returnSpringX) { returnSpringX.stop(); returnSpringX = null; }
    if (returnSpringY) { returnSpringY.stop(); returnSpringY = null; }
  }

  function applyKnob(x, y) {
    const R = travelRadius();
    const len = Math.hypot(x, y);
    if (len > R && len > 0) {
      // Progressive resistance past the edge — never a hard stop.
      const overshoot = len - R;
      const resisted = R + rubberband(overshoot, R);
      x = (x / len) * resisted;
      y = (y / len) * resisted;
    }
    knobPos.x = x;
    knobPos.y = y;
    renderKnob();

    const Rn = R || 1;
    vector.pan = clamp(x / Rn, -1, 1);
    vector.tilt = clamp(-y / Rn, -1, 1);
    updateAria();
    scheduleMove();
  }

  cleanups.push(draggable(pad, {
    onStart() {
      holding = true;
      moveFailed = false;
      stopReturnSprings();
      pad.classList.add('ptz-pad-active');
      updateSafetyWatch();
    },
    onMove({ dx, dy }) {
      // 1:1 tracking of pointer deltas — the knob never snaps to the pointer.
      applyKnob(dx, dy);
    },
    onEnd({ velocity, committed }) {
      holding = false;
      pad.classList.remove('ptz-pad-active');
      stopAxes({ panTilt: true, zoom: false });
      updateSafetyWatch();
      if (!committed || prefersReducedMotion()) {
        // Reduced motion: no spring travel — the knob snaps home.
        knobPos.x = 0; knobPos.y = 0; renderKnob();
        updateAria();
        return;
      }
      // Spring home, carrying the release velocity through. Bounce (0.8) is
      // allowed here: this is a momentum gesture.
      const R = travelRadius();
      returnSpringX = spring({
        from: knobPos.x, to: 0, velocity: clamp(velocity.x, -R * 8, R * 8),
        damping: 0.8, response: 0.4,
        onUpdate: (v) => { knobPos.x = v; renderKnob(); },
        onComplete: () => { returnSpringX = null; updateAria(); },
      });
      returnSpringY = spring({
        from: knobPos.y, to: 0, velocity: clamp(velocity.y, -R * 8, R * 8),
        damping: 0.8, response: 0.4,
        onUpdate: (v) => { knobPos.y = v; renderKnob(); },
        onComplete: () => { returnSpringY = null; updateAria(); },
      });
    },
    onCancel() {
      holding = false;
      pad.classList.remove('ptz-pad-active');
      stopAxes({ panTilt: true, zoom: false });
      updateSafetyWatch();
      stopReturnSprings();
      knobPos.x = 0; knobPos.y = 0; renderKnob();
      updateAria();
    },
  }));

  // Arrow keys: hold to move, release to stop. Each keydown adds a direction,
  // keyup removes it; when the last key lifts the camera is told to stop and
  // the knob returns critically damped (a key release carries no velocity).
  function applyPadKeys() {
    let vx = 0;
    let vy = 0;
    for (const key of padKeys) {
      vx += PAD_KEY_DIRS[key][0];
      vy += PAD_KEY_DIRS[key][1];
    }
    const len = Math.hypot(vx, vy);
    if (len > 1) { vx /= len; vy /= len; }
    const R = travelRadius();
    knobPos.x = vx * R * 0.8;
    knobPos.y = -vy * R * 0.8;
    renderKnob();
    vector.pan = vx;
    vector.tilt = vy;
    updateAria();
    scheduleMove();
  }

  function releasePadKeys() {
    stopAxes({ panTilt: true, zoom: false });
    if (prefersReducedMotion()) {
      knobPos.x = 0; knobPos.y = 0; renderKnob();
      updateAria();
      return;
    }
    stopReturnSprings();
    returnSpringX = spring({
      from: knobPos.x, to: 0, velocity: 0, damping: 1.0, response: 0.3,
      onUpdate: (v) => { knobPos.x = v; renderKnob(); },
      onComplete: () => { returnSpringX = null; updateAria(); },
    });
    returnSpringY = spring({
      from: knobPos.y, to: 0, velocity: 0, damping: 1.0, response: 0.3,
      onUpdate: (v) => { knobPos.y = v; renderKnob(); },
      onComplete: () => { returnSpringY = null; updateAria(); },
    });
  }

  function onPadKeyDown(e) {
    if (!PAD_KEY_DIRS[e.key]) return;
    e.preventDefault();
    if (e.repeat || padKeys.has(e.key)) return;
    padKeys.add(e.key);
    if (padKeys.size === 1) {
      moveFailed = false;
      stopReturnSprings();
      pad.classList.add('ptz-pad-active');
    }
    updateSafetyWatch();
    applyPadKeys();
  }

  function onPadKeyUp(e) {
    if (!PAD_KEY_DIRS[e.key] || !padKeys.has(e.key)) return;
    e.preventDefault();
    padKeys.delete(e.key);
    if (padKeys.size > 0) {
      applyPadKeys();
    } else {
      pad.classList.remove('ptz-pad-active');
      releasePadKeys();
      updateSafetyWatch();
    }
  }

  function onPadBlur() {
    // Focus lost mid-hold (e.g. Cmd-Tab) — keyup may never arrive. Stop.
    if (padKeys.size === 0) return;
    padKeys.clear();
    pad.classList.remove('ptz-pad-active');
    releasePadKeys();
    updateSafetyWatch();
  }

  pad.addEventListener('keydown', onPadKeyDown);
  pad.addEventListener('keyup', onPadKeyUp);
  pad.addEventListener('blur', onPadBlur);
  cleanups.push(() => {
    pad.removeEventListener('keydown', onPadKeyDown);
    pad.removeEventListener('keyup', onPadKeyUp);
    pad.removeEventListener('blur', onPadBlur);
  });

  wrap.appendChild(pad);

  // --- Zoom rocker ---
  const rocker = el('div', 'zoom-rocker');
  rocker.setAttribute('role', 'slider');
  rocker.setAttribute('aria-label', 'Zoom. Hold + or −, or the up and down arrow keys.');
  rocker.setAttribute('aria-orientation', 'vertical');
  rocker.setAttribute('aria-valuemin', '-100');
  rocker.setAttribute('aria-valuemax', '100');
  rocker.tabIndex = 0;
  rocker.append(el('span', 'zoom-label', '+'));
  const rockerThumb = el('div', 'zoom-thumb');
  rocker.appendChild(rockerThumb);
  rocker.append(el('span', 'zoom-label', '−'));

  let rockerValue = 0; // -1..1, 0 = rest
  let rockerSpring = null;
  let rockerHolding = false;

  function rockerTravel() {
    return Math.max(0, rocker.clientHeight / 2 - rockerThumb.offsetHeight / 2);
  }

  function renderRocker() {
    const y = -rockerValue * rockerTravel();
    rockerThumb.style.transform = `translate(-50%, -50%) translateY(${y}px)`;
  }

  function setRocker(v) {
    rockerValue = clamp(v, -1, 1);
    renderRocker();
    vector.zoom = rockerValue;
    updateAria();
    scheduleMove();
  }

  cleanups.push(draggable(rocker, {
    axis: 'y',
    hysteresis: 4,
    onStart() {
      rockerHolding = true;
      moveFailed = false;
      if (rockerSpring) { rockerSpring.stop(); rockerSpring = null; }
      rocker.classList.add('zoom-rocker-active');
      updateSafetyWatch();
    },
    onMove({ dy }) {
      const travel = rockerTravel() || 1;
      let v = -dy / travel;
      if (Math.abs(v) > 1) {
        v = Math.sign(v) * (1 + rubberband(Math.abs(v) - 1, 1) / 1);
      }
      setRocker(v);
    },
    onEnd({ velocity }) {
      rockerHolding = false;
      rocker.classList.remove('zoom-rocker-active');
      stopAxes({ panTilt: false, zoom: true });
      updateSafetyWatch();
      if (prefersReducedMotion()) {
        setRockerSilent(0);
        updateAria();
        return;
      }
      rockerSpring = spring({
        from: rockerValue, to: 0, velocity: clamp(-velocity.y / (rockerTravel() || 1), -8, 8),
        damping: 0.8, response: 0.35,
        onUpdate: (v) => { setRockerSilent(v); updateAria(); },
        onComplete: () => { rockerSpring = null; updateAria(); },
      });
    },
    onCancel() {
      rockerHolding = false;
      rocker.classList.remove('zoom-rocker-active');
      stopAxes({ panTilt: false, zoom: true });
      updateSafetyWatch();
      setRockerSilent(0);
      updateAria();
    },
  }));

  // Springing the thumb home must not re-send zoom commands — the stop was
  // already issued on release.
  function setRockerSilent(v) {
    rockerValue = v;
    renderRocker();
  }

  // +/− and up/down arrows: hold to zoom, release to stop. Critically damped
  // return — a key release carries no pointer velocity.
  function applyRockerKeys() {
    let v = 0;
    for (const key of rockerKeys) v += ROCKER_KEY_DIRS[key];
    setRocker(v);
  }

  function releaseRockerKeys() {
    stopAxes({ panTilt: false, zoom: true });
    if (rockerSpring) { rockerSpring.stop(); rockerSpring = null; }
    if (prefersReducedMotion()) {
      setRockerSilent(0);
      updateAria();
      return;
    }
    rockerSpring = spring({
      from: rockerValue, to: 0, velocity: 0, damping: 1.0, response: 0.3,
      onUpdate: (v) => { setRockerSilent(v); updateAria(); },
      onComplete: () => { rockerSpring = null; updateAria(); },
    });
  }

  function onRockerKeyDown(e) {
    if (!ROCKER_KEY_DIRS[e.key]) return;
    e.preventDefault();
    if (e.repeat || rockerKeys.has(e.key)) return;
    rockerKeys.add(e.key);
    if (rockerKeys.size === 1) {
      moveFailed = false;
      if (rockerSpring) { rockerSpring.stop(); rockerSpring = null; }
      rocker.classList.add('zoom-rocker-active');
    }
    updateSafetyWatch();
    applyRockerKeys();
  }

  function onRockerKeyUp(e) {
    if (!ROCKER_KEY_DIRS[e.key] || !rockerKeys.has(e.key)) return;
    e.preventDefault();
    rockerKeys.delete(e.key);
    if (rockerKeys.size > 0) {
      applyRockerKeys();
    } else {
      rocker.classList.remove('zoom-rocker-active');
      releaseRockerKeys();
      updateSafetyWatch();
    }
  }

  function onRockerBlur() {
    if (rockerKeys.size === 0) return;
    rockerKeys.clear();
    rocker.classList.remove('zoom-rocker-active');
    releaseRockerKeys();
    updateSafetyWatch();
  }

  rocker.addEventListener('keydown', onRockerKeyDown);
  rocker.addEventListener('keyup', onRockerKeyUp);
  rocker.addEventListener('blur', onRockerBlur);
  cleanups.push(() => {
    rocker.removeEventListener('keydown', onRockerKeyDown);
    rocker.removeEventListener('keyup', onRockerKeyUp);
    rocker.removeEventListener('blur', onRockerBlur);
  });

  wrap.appendChild(rocker);

  // --- Home + aux ---
  const actions = el('div', 'ptz-actions');
  let hasActions = false;

  if (ptz.homeSupported) {
    const homeBtn = el('button', 'btn btn-ghost btn-sm', 'Go home');
    homeBtn.type = 'button';
    cleanups.push(pressable(homeBtn));
    const go = () => api.ptzHome(sessionId, profile, 'goto').catch(reportError);
    homeBtn.addEventListener('click', go);
    cleanups.push(() => homeBtn.removeEventListener('click', go));
    actions.appendChild(homeBtn);
    hasActions = true;
  }

  if (Array.isArray(ptz.auxCommands) && ptz.auxCommands.length > 0) {
    for (const command of ptz.auxCommands) {
      const btn = el('button', 'btn btn-ghost btn-sm', prettyAux(command));
      btn.type = 'button';
      cleanups.push(pressable(btn));
      const run = () => api.ptzAux(sessionId, profile, command).catch(reportError);
      btn.addEventListener('click', run);
      cleanups.push(() => btn.removeEventListener('click', run));
      actions.appendChild(btn);
    }
    hasActions = true;
  }

  if (hasActions) wrap.appendChild(actions);

  // --- Focus / iris, only when Imaging exposes them ---
  const extras = el('div', 'ptz-extras');

  api.getImaging(sessionId, profile).then(({ settings, options }) => {
    if (destroyed || !settings) return;

    if (settings.focus) {
      const focusRow = el('div', 'focus-controls');
      focusRow.appendChild(el('span', 'control-label', 'Focus'));
      const speed = typeof settings.focus.defaultSpeed === 'number' ? settings.focus.defaultSpeed : 0.5;
      for (const [label, direction] of [['Near', -1], ['Far', 1]]) {
        const btn = el('button', 'btn btn-ghost btn-sm', label);
        btn.type = 'button';
        cleanups.push(pressable(btn));
        const start = (e) => {
          e.preventDefault();
          focusHolds += 1;
          updateSafetyWatch();
          api.focus(sessionId, profile, 'continuous', { speed: direction * speed }).catch(reportError);
        };
        const stop = () => {
          if (focusHolds === 0) return;
          focusHolds -= 1;
          updateSafetyWatch();
          api.focus(sessionId, profile, 'stop').catch(() => {});
        };
        btn.addEventListener('pointerdown', start);
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('pointercancel', stop);
        btn.addEventListener('pointerleave', stop);
        // Keyboard hold: Enter/Space down starts, keyup or blur stops. Focus
        // is a continuous control like the pad, so it cannot be click-only.
        const keyStart = (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault(); // keep Space from scrolling and from firing click
          if (e.repeat) return;
          start(e);
        };
        const keyStop = (e) => {
          if (e.type === 'keyup' && e.key !== 'Enter' && e.key !== ' ') return;
          stop();
        };
        btn.addEventListener('keydown', keyStart);
        btn.addEventListener('keyup', keyStop);
        btn.addEventListener('blur', keyStop);
        cleanups.push(() => {
          btn.removeEventListener('pointerdown', start);
          btn.removeEventListener('pointerup', stop);
          btn.removeEventListener('pointercancel', stop);
          btn.removeEventListener('pointerleave', stop);
          btn.removeEventListener('keydown', keyStart);
          btn.removeEventListener('keyup', keyStop);
          btn.removeEventListener('blur', keyStop);
        });
        focusRow.appendChild(btn);
      }
      extras.appendChild(focusRow);
    }

    if (settings.iris != null && options && options.iris) {
      const { min, max, step } = options.iris;
      const row = el('div', 'iris-control');
      row.appendChild(el('span', 'control-label', 'Iris'));
      const slider = el('input', 'slider');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step ?? 'any');
      slider.value = String(settings.iris);
      let timer = null;
      const onInput = () => {
        if (timer) clearTimeout(timer);
        const value = Number(slider.value);
        timer = setTimeout(() => {
          api.patchImaging(sessionId, profile, { iris: value }).catch(reportError);
        }, 250);
      };
      slider.addEventListener('input', onInput);
      cleanups.push(() => { slider.removeEventListener('input', onInput); if (timer) clearTimeout(timer); });
      row.appendChild(slider);
      extras.appendChild(row);
    }

    if (extras.childElementCount > 0) wrap.appendChild(extras);
  }).catch(() => {
    // Imaging unavailable — the pad simply renders without focus/iris.
  });

  // Re-render knob/thumb when the panel resizes so limits stay correct.
  const resizeObserver = new ResizeObserver(() => { renderKnob(); renderRocker(); });
  resizeObserver.observe(pad);
  cleanups.push(() => resizeObserver.disconnect());

  renderKnob();
  renderRocker();
  updateAria();
  container.appendChild(wrap);

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      if (trailingTimer) clearTimeout(trailingTimer);
      stopReturnSprings();
      if (rockerSpring) rockerSpring.stop();
      if (unsubscribeInactive) { unsubscribeInactive(); unsubscribeInactive = null; }
      // Never leave the camera moving because the panel went away — that
      // includes keyboard holds and the focus rocker, not just pointer drags.
      if (anyHoldActive()) {
        api.ptzStop(sessionId, profile, { panTilt: true, zoom: true }).catch(() => {});
        if (focusHolds > 0) api.focus(sessionId, profile, 'stop').catch(() => {});
      }
      cleanups.forEach((fn) => fn());
    },
  };
}
