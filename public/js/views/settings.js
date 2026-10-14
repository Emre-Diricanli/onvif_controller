// views/settings.js — the protocol-neutral settings panel (ADAPTERS.md).
//
// Every control is built from the descriptors the DEVICE declared: type,
// range, enum values, writability. Nothing here knows a vendor. Edits are
// staged and sent as one PATCH of only the changed keys, and each field then
// shows what the device actually did — applied, adjusted, unchanged,
// rejected or unknown — rather than assuming the write landed.

import { api, ApiError } from '../api.js';
import { pressable } from '../gesture.js';

const GROUP_LABELS = {
  imaging: 'Picture', encoder: 'Video encoder', osd: 'On-screen display', network: 'Network',
  time: 'Time', system: 'System', ptz: 'PTZ', other: 'Other',
};

const OUTCOME_TEXT = {
  applied: 'Applied',
  adjusted: 'Adjusted by device',
  unchanged: 'Ignored by device',
  rejected: 'Rejected by device',
  unknown: 'Not confirmed',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatValue(d, value) {
  if (value === undefined || value === null) return '—';
  if (d.type === 'bool') return value ? 'On' : 'Off';
  return d.unit ? `${value} ${d.unit}` : String(value);
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, onError: (err: ApiError) => void }} opts
 * @returns {() => void} teardown
 */
export function renderSettings(container, { sessionId, onError }) {
  const cleanups = [];
  let destroyed = false;
  let targets = [];
  let currentTarget = null;
  let descriptors = [];
  let values = {};
  let staged = {};

  const root = el('section', 'settings');
  const head = el('div', 'settings-head');
  const pickerLabel = el('label', 'settings-picker-label', 'Applies to');
  const picker = el('select', 'settings-picker');
  pickerLabel.appendChild(picker);
  const source = el('span', 'settings-source');
  head.append(pickerLabel, source);

  const body = el('div', 'settings-body');
  const status = el('p', 'panel-status', 'Loading settings…');
  const actions = el('div', 'settings-actions');
  const applyBtn = el('button', 'btn btn-primary', 'Apply changes');
  applyBtn.type = 'button';
  applyBtn.disabled = true;
  const resetBtn = el('button', 'btn btn-ghost', 'Discard');
  resetBtn.type = 'button';
  resetBtn.disabled = true;
  cleanups.push(pressable(applyBtn), pressable(resetBtn));
  actions.append(resetBtn, applyBtn);

  root.append(head, status, body, actions);
  container.appendChild(root);

  function report(err) {
    if (destroyed) return;
    onError?.(err instanceof ApiError ? err : new ApiError('INTERNAL', String(err?.message ?? err)));
  }

  function updateActions() {
    const dirty = Object.keys(staged).length > 0;
    applyBtn.disabled = !dirty;
    resetBtn.disabled = !dirty;
    applyBtn.textContent = dirty ? `Apply ${Object.keys(staged).length} change${Object.keys(staged).length === 1 ? '' : 's'}` : 'Apply changes';
  }

  function stage(key, value) {
    if (value === values[key]) delete staged[key];
    else staged[key] = value;
    updateActions();
  }

  function control(d) {
    const row = el('div', 'settings-row');
    row.dataset.key = d.key;
    const labelRow = el('div', 'settings-row-head');
    const name = el('span', 'settings-label', d.label);
    const shown = el('span', 'settings-value', formatValue(d, values[d.key]));
    const badge = el('span', 'settings-outcome');
    badge.hidden = true;
    labelRow.append(name, shown, badge);
    row.appendChild(labelRow);

    const current = values[d.key];
    let input;
    if ((d.type === 'int' || d.type === 'number') && d.min !== undefined && d.max !== undefined) {
      input = el('input', 'settings-slider');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step ?? (d.type === 'int' ? 1 : 'any'));
      input.value = String(current ?? d.min);
      const onInput = () => {
        const v = d.type === 'int' ? Math.round(Number(input.value)) : Number(input.value);
        shown.textContent = formatValue(d, v);
        stage(d.key, v);
      };
      input.addEventListener('input', onInput);
      cleanups.push(() => input.removeEventListener('input', onInput));
    } else if (d.type === 'int' || d.type === 'number') {
      input = el('input', 'settings-number');
      input.type = 'number';
      input.value = current ?? '';
      const onChange = () => stage(d.key, d.type === 'int' ? Math.round(Number(input.value)) : Number(input.value));
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    } else if (d.type === 'enum') {
      input = el('select', 'settings-select');
      for (const option of d.values) {
        const o = el('option', null, option);
        o.value = option;
        input.appendChild(o);
      }
      input.value = current ?? d.values[0];
      const onChange = () => { shown.textContent = formatValue(d, input.value); stage(d.key, input.value); };
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    } else if (d.type === 'bool') {
      input = el('input', 'toggle-input');
      input.type = 'checkbox';
      input.checked = Boolean(current);
      const onChange = () => { shown.textContent = formatValue(d, input.checked); stage(d.key, input.checked); };
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    } else {
      input = el('input', 'settings-text');
      input.type = 'text';
      input.value = current ?? '';
      const onChange = () => stage(d.key, input.value);
      input.addEventListener('change', onChange);
      cleanups.push(() => input.removeEventListener('change', onChange));
    }
    input.disabled = !d.writable;
    input.setAttribute('aria-label', d.label);
    if (!d.writable) row.classList.add('is-readonly');
    row.appendChild(input);
    return row;
  }

  function render() {
    body.replaceChildren();
    if (descriptors.length === 0) {
      status.hidden = false;
      status.textContent = 'This device reports no adjustable settings for this target.';
      return;
    }
    status.hidden = true;
    const groups = new Map();
    for (const d of descriptors) {
      if (!groups.has(d.group)) groups.set(d.group, []);
      groups.get(d.group).push(d);
    }
    for (const [group, list] of groups) {
      const section = el('div', 'settings-group');
      section.appendChild(el('h3', 'settings-group-title', GROUP_LABELS[group] ?? group));
      for (const d of list) section.appendChild(control(d));
      body.appendChild(section);
    }
  }

  async function loadTarget(targetId) {
    currentTarget = targetId;
    staged = {};
    updateActions();
    status.hidden = false;
    status.textContent = 'Reading from the device…';
    body.replaceChildren();
    try {
      const [described, read] = await Promise.all([
        api.describeSettings(sessionId, targetId),
        api.readSettings(sessionId, targetId),
      ]);
      if (destroyed || currentTarget !== targetId) return;
      descriptors = described.descriptors;
      values = read.values;
      source.textContent = `via ${read.source}`;
      render();
    } catch (err) {
      status.textContent = 'Could not read settings for this target.';
      report(err);
    }
  }

  async function apply() {
    const patch = { ...staged };
    if (!Object.keys(patch).length) return;
    applyBtn.disabled = true;
    resetBtn.disabled = true;
    applyBtn.textContent = 'Applying…';
    try {
      const result = await api.writeSettings(sessionId, currentTarget, patch);
      if (destroyed) return;
      source.textContent = result.fallbackFrom
        ? `via ${result.source} (${result.fallbackFrom} ignored the write)`
        : `via ${result.source}`;
      Object.assign(values, result.values);
      staged = {};
      render();
      for (const [key, r] of Object.entries(result.results ?? {})) {
        const row = body.querySelector(`[data-key="${CSS.escape(key)}"]`);
        const badge = row?.querySelector('.settings-outcome');
        if (!badge) continue;
        badge.hidden = false;
        badge.textContent = OUTCOME_TEXT[r.outcome] ?? r.outcome;
        badge.dataset.outcome = r.outcome;
        if (r.outcome === 'adjusted') badge.title = `Asked for ${r.requested}, device holds ${r.observed}.`;
        if (r.outcome === 'unknown') badge.title = 'The write was sent but could not be read back. Check the device before retrying.';
      }
    } catch (err) {
      report(err);
    } finally {
      updateActions();
    }
  }

  const onPick = () => loadTarget(picker.value);
  picker.addEventListener('change', onPick);
  const onApply = () => apply();
  applyBtn.addEventListener('click', onApply);
  const onReset = () => { staged = {}; render(); updateActions(); };
  resetBtn.addEventListener('click', onReset);
  cleanups.push(
    () => picker.removeEventListener('change', onPick),
    () => applyBtn.removeEventListener('click', onApply),
    () => resetBtn.removeEventListener('click', onReset),
  );

  (async () => {
    try {
      const res = await api.getTargets(sessionId);
      if (destroyed) return;
      targets = res.targets ?? [];
      if (!targets.length) {
        status.textContent = 'This device reports nothing that can be configured.';
        return;
      }
      for (const t of targets) {
        const o = el('option', null, t.label);
        o.value = t.id;
        picker.appendChild(o);
      }
      picker.disabled = targets.length === 1;
      await loadTarget(targets[0].id);
    } catch (err) {
      status.textContent = 'Could not list this device’s settings.';
      report(err);
    }
  })();

  return () => {
    destroyed = true;
    for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
    root.remove();
  };
}

/**
 * A whole screen for a device reached through a vendor API alone: no video,
 * no PTZ, just its settings — which is the reason the operator connected.
 *
 * @param {HTMLElement} root
 * @param {{ session: object, onDisconnect: (reason?: object) => void }} opts
 * @returns {() => void} teardown
 */
export function renderVendorDevice(root, { session, onDisconnect }) {
  const screen = el('main', 'vendor-device');
  const header = el('header', 'vendor-device-head');
  const titleBox = el('div', 'vendor-device-title');
  const name = [session.device?.manufacturer, session.device?.model].filter(Boolean).join(' ') || 'Device';
  titleBox.append(el('h1', null, name), el('p', 'vendor-device-sub',
    `Connected through ${session.protocol}. Live video and PTZ need ONVIF; device settings are below.`));
  const disconnectBtn = el('button', 'btn btn-ghost btn-sm', 'Disconnect');
  disconnectBtn.type = 'button';
  header.append(titleBox, disconnectBtn);
  const errorBox = el('div', 'error-box');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  const panel = el('div', 'vendor-device-panel');
  screen.append(header, errorBox, panel);
  root.appendChild(screen);

  const showError = (err) => {
    if (err?.code === 'SESSION_EXPIRED') { onDisconnect(err); return; }
    errorBox.hidden = false;
    errorBox.textContent = err.hint ? `${err.message} ${err.hint}` : err.message;
  };
  const teardownSettings = renderSettings(panel, { sessionId: session.sessionId, onError: showError });
  const releasePress = pressable(disconnectBtn);
  const onDisconnectClick = async () => {
    try { await api.disconnect(session.sessionId); } catch { /* already gone */ }
    onDisconnect();
  };
  disconnectBtn.addEventListener('click', onDisconnectClick);

  return () => {
    teardownSettings();
    releasePress();
    disconnectBtn.removeEventListener('click', onDisconnectClick);
    screen.remove();
  };
}
