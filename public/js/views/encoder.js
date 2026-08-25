// views/encoder.js — device-driven video encoder configuration.
//
// Every control is built from the device's reported `options` object — the
// resolution picker from options.resolutions for the currently selected
// encoding (per-profile, disjoint sets), framerate and bitrate sliders from
// options.fps / options.bitrate. An absent option key means an absent
// control, never a disabled one and never a hardcoded list.
//
// Unlike the imaging view, nothing is written on drag: changes are staged,
// summarised, and applied explicitly, because each write interrupts the live
// view. After a PATCH the UI reflects the device's read-back state and
// reports any field the camera kept at its previous value.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

// A short secondary label for a resolution: megapixels when meaningful,
// plus the aspect ratio when it is a common one.
function resolutionHint(width, height) {
  const parts = [];
  const megapixels = (width * height) / 1e6;
  if (megapixels >= 1) parts.push(`${megapixels.toFixed(1)} MP`);
  const divisor = gcd(width, height);
  const aspect = `${width / divisor}:${height / divisor}`;
  if (['16:9', '16:10', '4:3', '3:2', '5:4'].includes(aspect)) parts.push(aspect);
  return parts.join(' · ');
}

function resolutionLabel(width, height) {
  return `${width}×${height}`;
}

async function request(sessionId, { method = 'GET', profile, settings } = {}) {
  const base = `/api/session/${encodeURIComponent(sessionId)}/encoder`;
  const url = method === 'GET' ? `${base}?profile=${encodeURIComponent(profile)}` : base;
  const res = await fetch(url, {
    method,
    headers: settings ? { 'Content-Type': 'application/json' } : undefined,
    body: settings ? JSON.stringify({ profile, settings }) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const source = data?.error ?? {};
    const err = new Error(source.message ?? `Request failed with status ${res.status}.`);
    Object.assign(err, { code: source.code ?? 'INTERNAL', hint: source.hint ?? null, status: res.status });
    throw err;
  }
  return data;
}

const REFUSED_TEXT = 'The camera accepted this change and then kept its previous value.';

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, profile: string,
 *           onError: (err: Error) => void,
 *           onApplied?: (response: object) => void }} opts
 * @returns {() => void} teardown
 */
export function renderEncoder(container, { sessionId, profile, onError, onApplied }) {
  let destroyed = false;
  const cleanups = [];
  const controls = new Map();
  let data = null;   // last known { current, options }
  let staged = null; // working copy of current, edited by the operator

  const wrap = el('section', 'encoder');
  const status = el('p', 'encoder-status', 'Reading encoder settings…');

  const errorBox = el('div', 'encoder-error');
  errorBox.hidden = true;

  const body = el('div', 'encoder-body');

  const stagedBox = el('div', 'encoder-staged');
  stagedBox.hidden = true;
  const stagedTitle = el('p', 'encoder-staged-title', 'Staged changes');
  const stagedList = el('ul', 'encoder-staged-list');
  const warning = el('p', 'encoder-warning',
    'Applying changes to the profile being watched interrupts the live view for a few seconds.');
  const actions = el('div', 'encoder-actions');
  const applyBtn = el('button', 'encoder-apply', 'Apply changes');
  applyBtn.type = 'button';
  const discardBtn = el('button', 'encoder-discard', 'Discard');
  discardBtn.type = 'button';
  actions.append(applyBtn, discardBtn);
  stagedBox.append(stagedTitle, stagedList, warning, actions);

  const result = el('p', 'encoder-result');
  result.setAttribute('aria-live', 'polite');
  result.tabIndex = -1;

  wrap.append(status, errorBox, body, stagedBox, result);
  container.appendChild(wrap);

  function report(err) {
    if (!destroyed && typeof onError === 'function') onError(err);
  }

  function listen(node, type, handler) {
    node.addEventListener(type, handler);
    cleanups.push(() => node.removeEventListener(type, handler));
  }

  function snapshot(current) {
    return {
      encoding: current.encoding ?? null,
      width: current.width ?? null,
      height: current.height ?? null,
      fps: current.fps ?? null,
      bitrateKbps: current.bitrateKbps ?? null,
    };
  }

  function activeEncoding() {
    return staged?.encoding ?? data?.current?.encoding ?? null;
  }

  function resolutionsFor(encoding) {
    const table = data?.options?.resolutions;
    if (!table || typeof table !== 'object' || encoding == null) return [];
    const list = table[encoding];
    return Array.isArray(list) ? list : [];
  }

  // A staged resolution that the device does not offer under the staged
  // encoding must be named, never silently swapped for another one.
  function resolutionProblem() {
    if (staged?.width == null || staged?.height == null) return null;
    if (!data?.options?.resolutions) return null;
    const list = resolutionsFor(activeEncoding());
    if (!list.length) return null;
    const offered = list.some((r) => r.width === staged.width && r.height === staged.height);
    if (offered) return null;
    return `${resolutionLabel(staged.width, staged.height)} is not available with ${activeEncoding()} — choose a resolution below.`;
  }

  function changedSettings() {
    const base = data?.current ?? {};
    const diff = {};
    if (staged.encoding != null && staged.encoding !== base.encoding) diff.encoding = staged.encoding;
    if (staged.width != null && staged.height != null &&
        (staged.width !== base.width || staged.height !== base.height)) {
      diff.width = staged.width;
      diff.height = staged.height;
    }
    if (staged.fps != null && staged.fps !== base.fps) diff.fps = staged.fps;
    if (staged.bitrateKbps != null && staged.bitrateKbps !== base.bitrateKbps) diff.bitrateKbps = staged.bitrateKbps;
    return diff;
  }

  function summaryLines(diff) {
    const base = data?.current ?? {};
    const lines = [];
    if (diff.encoding != null) lines.push(`Codec: ${base.encoding ?? '—'} → ${diff.encoding}`);
    if (diff.width != null) {
      lines.push(`Resolution: ${resolutionLabel(base.width, base.height)} → ${resolutionLabel(diff.width, diff.height)}`);
    }
    if (diff.fps != null) lines.push(`Framerate: ${base.fps ?? '—'} fps → ${diff.fps} fps`);
    if (diff.bitrateKbps != null) lines.push(`Bitrate: ${base.bitrateKbps ?? '—'} kbps → ${diff.bitrateKbps} kbps`);
    return lines;
  }

  function updateStaged() {
    const diff = changedSettings();
    const lines = summaryLines(diff);
    stagedList.replaceChildren(...lines.map((line) => el('li', null, line)));
    const problem = resolutionProblem();
    stagedBox.hidden = lines.length === 0 && !problem;
    applyBtn.disabled = lines.length === 0 || Boolean(problem);
    const resolution = controls.get('resolution');
    if (resolution) {
      resolution.message.textContent = problem ?? '';
      resolution.row.classList.toggle('encoder-field-invalid', Boolean(problem));
    }
  }

  function buildEncoding() {
    const encodings = data.options?.encodings;
    if (!Array.isArray(encodings) || encodings.length === 0) return;

    const row = el('div', 'encoder-field');
    row.appendChild(el('span', 'encoder-label', 'Codec'));
    const group = el('div', 'encoder-segmented');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Codec');
    const message = el('p', 'encoder-message');
    message.setAttribute('aria-live', 'polite');

    const buttons = [];
    const setActive = (value) => {
      for (const [btn, v] of buttons) {
        const active = v === value;
        btn.classList.toggle('encoder-segment-active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
    };

    for (const choice of encodings) {
      const value = String(choice);
      const btn = el('button', 'encoder-segment', value);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      buttons.push([btn, value]);
      listen(btn, 'click', () => {
        if (staged.encoding === value) return;
        staged.encoding = value;
        setActive(value);
        controls.get('resolution')?.refresh();
        message.textContent = '';
        updateStaged();
      });
      group.appendChild(btn);
    }
    setActive(staged.encoding);

    row.append(group, message);
    body.appendChild(row);
    controls.set('encoding', { row, message, setActive });
  }

  function buildResolution() {
    const table = data.options?.resolutions;
    if (!table || typeof table !== 'object') return;

    const row = el('div', 'encoder-field');
    row.appendChild(el('span', 'encoder-label', 'Resolution'));
    const group = el('div', 'encoder-resolutions');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Resolution');
    const message = el('p', 'encoder-message');
    message.setAttribute('aria-live', 'polite');
    row.append(group, message);
    body.appendChild(row);

    let buttons = [];
    const refresh = () => {
      group.replaceChildren();
      buttons = [];
      const encoding = activeEncoding();
      const list = resolutionsFor(encoding);
      if (!list.length) {
        group.appendChild(el('p', 'encoder-resolutions-empty',
          `This device did not report any resolutions for ${encoding ?? 'this codec'}.`));
        return;
      }
      for (const { width, height } of list) {
        const btn = el('button', 'encoder-resolution');
        btn.type = 'button';
        const name = el('span', 'encoder-resolution-name', resolutionLabel(width, height));
        const hint = resolutionHint(width, height);
        btn.appendChild(name);
        if (hint) btn.appendChild(el('span', 'encoder-resolution-hint', hint));
        const select = (selected) => {
          for (const [b, entry] of buttons) {
            const active = entry === selected;
            b.classList.toggle('encoder-resolution-active', active);
            b.setAttribute('aria-pressed', String(active));
          }
        };
        const entry = { width, height, select };
        buttons.push([btn, entry]);
        listen(btn, 'click', () => {
          staged.width = width;
          staged.height = height;
          select(entry);
          message.textContent = '';
          row.classList.remove('encoder-field-invalid');
          updateStaged();
        });
        btn.setAttribute('aria-pressed', 'false');
        group.appendChild(btn);
      }
      const current = buttons.find(([, entry]) => entry.width === staged.width && entry.height === staged.height);
      if (current) current[1].select(current[1]);
    };
    refresh();
    controls.set('resolution', { row, message, refresh });
  }

  function buildSlider(key, label, unit, optionsKey) {
    const range = data.options?.[optionsKey];
    const value = data.current?.[key];
    if (value == null || !range || range.min == null || range.max == null) return;

    const row = el('div', 'encoder-field');
    const head = el('div', 'encoder-slider-head');
    const labelEl = el('label', 'encoder-label', label);
    const id = `encoder-${key}`;
    labelEl.htmlFor = id;
    const valueEl = el('span', 'encoder-slider-value', `${value} ${unit}`);
    head.append(labelEl, valueEl);

    const slider = el('input', 'encoder-slider');
    slider.type = 'range';
    slider.id = id;
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = range.step != null ? String(range.step) : '1';
    slider.value = String(value);
    slider.setAttribute('aria-valuenow', String(value));
    slider.setAttribute('aria-valuetext', `${value} ${unit}`);

    const message = el('p', 'encoder-message');
    message.setAttribute('aria-live', 'polite');
    row.append(head, slider, message);
    body.appendChild(row);

    const set = (v) => {
      slider.value = String(v);
      slider.setAttribute('aria-valuenow', String(v));
      slider.setAttribute('aria-valuetext', `${v} ${unit}`);
      valueEl.textContent = `${v} ${unit}`;
    };
    listen(slider, 'input', () => {
      staged[key] = Number(slider.value);
      set(staged[key]);
      message.textContent = '';
      updateStaged();
    });
    controls.set(key, { row, message, set });
  }

  function setFieldMessage(key, text) {
    const entry = controls.get(key);
    if (!entry) return;
    entry.message.textContent = text;
    entry.row.classList.toggle('encoder-field-refused', Boolean(text));
  }

  function render(next) {
    data = next;
    staged = snapshot(next.current ?? {});
    body.replaceChildren();
    controls.clear();
    result.textContent = '';

    buildEncoding();
    buildResolution();
    buildSlider('fps', 'Framerate', 'fps', 'fps');
    buildSlider('bitrateKbps', 'Bitrate', 'kbps', 'bitrate');

    if (controls.size === 0) {
      status.hidden = false;
      status.textContent = 'This device exposes no configurable encoder settings.';
      return false;
    }
    status.hidden = true;
    updateStaged();
    return true;
  }

  function resetControls() {
    staged = snapshot(data.current ?? {});
    controls.get('encoding')?.setActive(staged.encoding);
    controls.get('resolution')?.refresh();
    if (staged.fps != null) controls.get('fps')?.set(staged.fps);
    if (staged.bitrateKbps != null) controls.get('bitrateKbps')?.set(staged.bitrateKbps);
    for (const key of ['encoding', 'resolution', 'fps', 'bitrateKbps']) setFieldMessage(key, '');
    result.textContent = '';
    updateStaged();
  }

  listen(discardBtn, 'click', () => resetControls());

  listen(applyBtn, 'click', async () => {
    const diff = changedSettings();
    if (Object.keys(diff).length === 0 || resolutionProblem()) return;
    applyBtn.disabled = true;
    discardBtn.disabled = true;
    result.textContent = 'Applying and verifying with the camera…';
    try {
      const response = await request(sessionId, { method: 'PATCH', profile, settings: diff });
      if (destroyed) return;
      const refusedByKey = { encoding: 'encoding', width: 'resolution', height: 'resolution', fps: 'fps', bitrateKbps: 'bitrateKbps' };
      const refused = Object.keys(diff).filter((key) => response.applied?.[key] === false);
      render(response);
      for (const key of new Set(refused.map((k) => refusedByKey[k]))) setFieldMessage(key, REFUSED_TEXT);
      if (refused.length) {
        result.textContent = 'Some changes were not applied. Review the messages above.';
      } else if (response.streamRestartRequired) {
        result.textContent = 'All changes were verified on the camera. The live view will restart and may take a few seconds.';
      } else {
        result.textContent = 'All changes were verified on the camera.';
      }
      if (typeof onApplied === 'function') onApplied(response);
      result.focus({ preventScroll: true });
    } catch (err) {
      if (destroyed) return;
      result.textContent = err.hint
        ? `The encoder settings could not be applied. ${err.message} ${err.hint}`
        : `The encoder settings could not be applied. ${err.message}`;
      report(err);
    } finally {
      if (!destroyed) {
        applyBtn.disabled = false;
        discardBtn.disabled = false;
        updateStaged();
      }
    }
  });

  request(sessionId, { profile }).then((response) => {
    if (destroyed) return;
    render(response);
  }).catch((err) => {
    if (destroyed) return;
    status.textContent = 'Encoder settings could not be read.';
    errorBox.replaceChildren(el('p', 'encoder-error-message', err.message ?? 'Unknown error.'));
    if (err.hint) errorBox.appendChild(el('p', 'encoder-error-hint', err.hint));
    errorBox.hidden = false;
    report(err);
  });

  return () => {
    destroyed = true;
    cleanups.splice(0).forEach((cleanup) => cleanup());
    wrap.remove();
  };
}
