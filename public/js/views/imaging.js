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
  const refusedFields = new Set();
  const REFUSED_TEXT = 'The camera accepted this change and then kept its previous value.';
  let destroyed = false;

  const wrap = el('div', 'imaging');
  const status = el('p', 'panel-status', 'Reading imaging settings…');
  const body = el('div', 'imaging-body');

  const stubNotice = el('div', 'imaging-stub-notice');
  stubNotice.append(
    el('p', 'imaging-stub-title', 'This camera does not apply imaging changes'),
    el('p', 'imaging-stub-body',
      'It reports adjustable ranges and answers every change with success, but keeps its own values. '
      + 'That is a limitation of the camera firmware, not of this controller — retrying will not help. '
      + 'Use the camera\u2019s own app or web interface to adjust the picture.'),
  );
  stubNotice.hidden = true;

  const sourceNotice = el('p', 'imaging-source-notice');
  sourceNotice.hidden = true;

  wrap.append(status, stubNotice, sourceNotice, body);
  container.appendChild(wrap);

  // Every control owns its presentation value until its newest write settles.
  const sliders = new Map();
  const segmented = new Map();
  const debounceTimers = new Map();
  const sequences = new Map();

  function reportError(err) {
    if (destroyed) return;
    if (err instanceof ApiError) onError(err);
  }

  function debouncedPatch(pathKey, settingsFragment) {
    const sequence = (sequences.get(pathKey) ?? 0) + 1;
    sequences.set(pathKey, sequence);
    if (debounceTimers.has(pathKey)) clearTimeout(debounceTimers.get(pathKey));
    debounceTimers.set(pathKey, setTimeout(() => {
      debounceTimers.delete(pathKey);
      api.patchImaging(sessionId, profile, settingsFragment)
        .then((res) => { if (!destroyed && sequences.get(pathKey) === sequence) applyFieldState(pathKey, res); })
        .catch((err) => { if (sequences.get(pathKey) === sequence) reportError(err); });
    }, DEBOUNCE_MS));
  }

  function applyFieldState(pathKey, res) {
    if (!res?.settings) return;
    const entry = sliders.get(pathKey) ?? segmented.get(pathKey);
    if (!entry) return;
    const value = getPath(res.settings, entry.path);
    const applied = res.applied?.[entry.path[0]] !== false;
    if (value != null) {
      if (entry.slider) {
        entry.slider.value = String(value);
        entry.valueEl.textContent = String(value);
      } else {
        selectSegment(entry, String(value));
      }
    }
    entry.message.textContent = applied ? '' : REFUSED_TEXT;
    entry.row.classList.toggle('imaging-control-refused', !applied);

    if (!applied) refusedFields.add(pathKey);
    else refusedFields.delete(pathKey);
    if (res.source && res.source !== 'onvif') {
      // The vendor path answered, so the earlier refusals no longer stand.
      refusedFields.clear();
      entry.message.textContent = '';
      entry.row.classList.remove('imaging-control-refused');
    }
    updateSourceNotice(res);
    updateStubNotice();
  }

  /**
   * Some cameras expose the Imaging service, advertise option ranges, answer
   * SetImagingSettings with a success envelope, and then apply nothing. That is
   * firmware, not a bug here and not something the operator can fix by trying
   * again — so once several distinct controls have all been ignored, say what is
   * actually going on instead of repeating a per-field "refused" forever.
   */
  /**
   * Tell the operator which path actually moved the picture. ONVIF is silent
   * because it is the expected case; the proprietary fallback is worth naming,
   * because it is undocumented, firmware-specific, and can stop working after
   * a camera update.
   */
  function updateSourceNotice(res) {
    const viaVendor = Boolean(res?.source) && res.source !== 'onvif';
    sourceNotice.hidden = !viaVendor;
    if (viaVendor) {
      sourceNotice.textContent =
        `This camera ignores ONVIF imaging commands, so these controls are going through its `
        + `${res.driver || 'own'} interface instead. That is an undocumented API and may stop `
        + `working after a firmware update.`;
    }
  }

  function updateStubNotice() {
    // Superseded once the vendor path is driving the picture.
    if (!sourceNotice.hidden) { stubNotice.hidden = true; return; }
    const looksLikeStub = refusedFields.size >= 1;
    stubNotice.hidden = !looksLikeStub;
    for (const [key, entry] of [...sliders, ...segmented]) {
      if (!entry.message) continue;
      if (looksLikeStub && refusedFields.has(key)) entry.message.textContent = '';
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
    const message = el('p', 'imaging-control-message');
    message.setAttribute('aria-live', 'polite');
    row.append(head, slider, message);

    const entry = { slider, path: [key], valueEl: head.lastChild, message, row };
    sliders.set(pathKey, entry);

    const onInput = () => {
      entry.valueEl.textContent = slider.value;
      entry.message.textContent = '';
      entry.row.classList.remove('imaging-control-refused');
      const fragment = {};
      setPath(fragment, [key], Number(slider.value));
      debouncedPatch(pathKey, fragment);
    };
    slider.addEventListener('input', onInput);
    cleanups.push(() => {
      slider.removeEventListener('input', onInput);
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

    const message = el('p', 'imaging-control-message');
    message.setAttribute('aria-live', 'polite');
    const entry = { path, buttons: [], message, row };
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
        const sequence = (sequences.get(pathKey) ?? 0) + 1;
        sequences.set(pathKey, sequence);
        entry.message.textContent = '';
        row.classList.remove('imaging-control-refused');
        api.patchImaging(sessionId, profile, fragment)
          .then((res) => { if (!destroyed && sequences.get(pathKey) === sequence) applyFieldState(pathKey, res); })
          .catch((err) => { if (sequences.get(pathKey) === sequence) reportError(err); })
          .finally(() => {
            if (destroyed) return;
            group.classList.remove('segmented-busy');
            for (const [b] of entry.buttons) b.disabled = false;
          });
      };
      btn.addEventListener('click', choose);
      cleanups.push(() => btn.removeEventListener('click', choose));
      group.appendChild(btn);
    }
    selectSegment(entry, String(current));
    row.append(group, message);
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
