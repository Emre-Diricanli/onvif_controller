// views/imaging.js — device-driven imaging controls.
//
// Every slider's min/max/step comes from the device's reported `options`
// object — never hardcoded. Only keys actually present in the response are
// rendered. PATCH writes are debounced while the thumb stays 1:1 with the
// pointer, and the UI reflects the device's post-write state from the PATCH
// response rather than assuming the write landed.

import { api, ApiError } from '../api.js';
import { pressable } from '../gesture.js';

const DEBOUNCE_MS = 250;

// Numeric settings that render as sliders when present in both `settings`
// and `options`.
const SLIDER_KEYS = [
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['colorSaturation', 'Saturation'],
  ['sharpness', 'Sharpness'],
];

// Segmented controls: [settingsPath, label, optionsKey]
const SEGMENTED_KEYS = [
  [['irCutFilter'], 'IR-cut filter', 'irCutFilter'],
  [['whiteBalance', 'mode'], 'White balance', 'whiteBalanceModes'],
  [['exposure', 'mode'], 'Exposure mode', 'exposureModes'],
  [['wideDynamicRange', 'mode'], 'WDR', 'wideDynamicRangeModes'],
  [['backlightCompensation', 'mode'], 'Backlight', 'backlightCompensationModes'],
  [['focus', 'autoFocusMode'], 'Autofocus', 'autoFocusModes'],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj, path, value) {
  if (path.length === 1) {
    obj[path[0]] = value;
    return;
  }
  if (obj[path[0]] == null || typeof obj[path[0]] !== 'object') obj[path[0]] = {};
  obj[path[0]][path[1]] = value;
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, profile: string, onError: (err: ApiError) => void }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function renderImaging(container, { sessionId, profile, onError }) {
  const cleanups = [];
  let destroyed = false;

  const wrap = el('div', 'imaging');
  const status = el('p', 'panel-status', 'Reading imaging settings…');
  const body = el('div', 'imaging-body');
  wrap.append(status, body);
  container.appendChild(wrap);

  // key (JSON path string) -> { slider } for re-syncing from PATCH responses.
  const sliders = new Map();
  const segmented = new Map();
  // Keys currently being dragged — their thumbs must stay 1:1 with the
  // pointer, so server echoes never fight an active gesture.
  const dragging = new Set();
  const debounceTimers = new Map();

  function reportError(err) {
    if (destroyed) return;
    if (err instanceof ApiError) onError(err);
  }

  function debouncedPatch(pathKey, settingsFragment) {
    if (debounceTimers.has(pathKey)) clearTimeout(debounceTimers.get(pathKey));
    debounceTimers.set(pathKey, setTimeout(() => {
      debounceTimers.delete(pathKey);
      api.patchImaging(sessionId, profile, settingsFragment)
        .then((res) => { if (!destroyed) applyServerState(res); })
        .catch(reportError);
    }, DEBOUNCE_MS));
  }

  function applyServerState(res) {
    if (!res || !res.settings) return;
    for (const [pathKey, entry] of sliders) {
      if (dragging.has(pathKey)) continue;
      const value = getPath(res.settings, entry.path);
      if (value != null) entry.slider.value = String(value);
    }
    for (const [pathKey, entry] of segmented) {
      const value = getPath(res.settings, entry.path);
      if (value != null) selectSegment(entry, String(value));
    }
  }

  function buildSlider(settings, options, key, label) {
    const range = options[key];
    const value = settings[key];
    if (value == null || !range || range.min == null || range.max == null) return null;

    const pathKey = key;
    const row = el('div', 'slider-row');
    const head = el('div', 'slider-head');
    head.append(el('span', 'control-label', label), el('span', 'slider-value', String(value)));
    const slider = el('input', 'slider');
    slider.type = 'range';
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = range.step != null ? String(range.step) : 'any';
    slider.value = String(value);
    slider.setAttribute('aria-label', label);
    row.append(head, slider);

    const entry = { slider, path: [key], valueEl: head.lastChild };
    sliders.set(pathKey, entry);

    const onInput = () => {
      entry.valueEl.textContent = slider.value;
      const fragment = {};
      setPath(fragment, [key], Number(slider.value));
      debouncedPatch(pathKey, fragment);
    };
    const onDown = () => dragging.add(pathKey);
    const onUp = () => dragging.delete(pathKey);
    slider.addEventListener('input', onInput);
    slider.addEventListener('pointerdown', onDown);
    slider.addEventListener('pointerup', onUp);
    slider.addEventListener('pointercancel', onUp);
    cleanups.push(() => {
      slider.removeEventListener('input', onInput);
      slider.removeEventListener('pointerdown', onDown);
      slider.removeEventListener('pointerup', onUp);
      slider.removeEventListener('pointercancel', onUp);
    });
    return row;
  }

  function selectSegment(entry, value) {
    for (const [btn, v] of entry.buttons) {
      const active = v === value;
      btn.classList.toggle('segment-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
  }

  function buildSegmented(settings, options, path, label, optionsKey) {
    const choices = options[optionsKey];
    const current = getPath(settings, path);
    if (!Array.isArray(choices) || choices.length === 0 || current == null) return null;

    const pathKey = path.join('.');
    const row = el('div', 'segmented-row');
    row.appendChild(el('span', 'control-label', label));
    const group = el('div', 'segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);

    const entry = { path, buttons: [] };
    segmented.set(pathKey, entry);

    for (const choice of choices) {
      const value = String(choice);
      const btn = el('button', 'segment', value);
      btn.type = 'button';
      cleanups.push(pressable(btn, { scale: 0.94 }));
      entry.buttons.push([btn, value]);
      const choose = () => {
        if (btn.disabled) return;
        group.classList.add('segmented-busy');
        for (const [b] of entry.buttons) b.disabled = true;
        const fragment = {};
        setPath(fragment, path, choice);
        api.patchImaging(sessionId, profile, fragment)
          .then((res) => { if (!destroyed) applyServerState(res); })
          .catch(reportError)
          .finally(() => {
            if (destroyed) return;
            group.classList.remove('segmented-busy');
            for (const [b] of entry.buttons) b.disabled = false;
          });
      };
      btn.addEventListener('pointerup', choose);
      cleanups.push(() => btn.removeEventListener('pointerup', choose));
      group.appendChild(btn);
    }
    selectSegment(entry, String(current));
    row.appendChild(group);
    return row;
  }

  api.getImaging(sessionId, profile).then(({ settings, options }) => {
    if (destroyed) return;
    if (!settings || typeof settings !== 'object') {
      status.textContent = 'This device did not report any imaging settings.';
      return;
    }
    status.hidden = true;

    let rendered = 0;
    for (const [key, label] of SLIDER_KEYS) {
      const row = buildSlider(settings, options || {}, key, label);
      if (row) { body.appendChild(row); rendered += 1; }
    }
    for (const [path, label, optionsKey] of SEGMENTED_KEYS) {
      const row = buildSegmented(settings, options || {}, path, label, optionsKey);
      if (row) { body.appendChild(row); rendered += 1; }
    }
    if (rendered === 0) {
      status.hidden = false;
      status.textContent = 'This device exposes the Imaging service but reported no adjustable settings.';
    }
  }).catch((err) => {
    if (destroyed) return;
    status.textContent = 'Imaging settings could not be read.';
    reportError(err);
  });

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      cleanups.forEach((fn) => fn());
    },
  };
}
