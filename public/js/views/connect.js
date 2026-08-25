// views/connect.js — the connect screen.
//
// Live inline validation (as the user types, not on submit), a four-stage
// progress narrative while the ONVIF handshake runs, and error messages that
// map every ApiError code to the specific actionable text from SPEC.md §4.
// "Remember on this device" persists host/port/username to localStorage and
// NEVER the password.

import { api, ApiError } from '../api.js';
import { pressable } from '../gesture.js';

const REMEMBER_KEY = 'onvif-controller:remembered';

const STAGES = [
  'Reaching device',
  'Authenticating',
  'Reading capabilities',
  'Fetching profiles',
];

// Conservative shapes: IPv4, or a DNS hostname (labels, dots, hyphens).
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/;

function validateHost(host) {
  if (!host) return 'Enter the camera IP address or hostname.';
  if (IPV4_RE.test(host)) {
    const bad = host.split('.').some((octet) => Number(octet) > 255);
    if (bad) return 'Each IPv4 octet must be between 0 and 255.';
    return null;
  }
  if (!HOSTNAME_RE.test(host)) return 'That is not a valid IP address or hostname.';
  return null;
}

function validatePort(port) {
  if (!port) return 'Enter a port.';
  if (!/^\d+$/.test(port)) return 'Port must be a number.';
  const n = Number(port);
  if (n < 1 || n > 65535) return 'Port must be between 1 and 65535.';
  return null;
}

function validateUsername(username) {
  if (!username) return 'Enter the ONVIF username.';
  return null;
}

function validatePassword(password) {
  if (!password) return 'Enter the ONVIF password.';
  return null;
}

/**
 * SPEC.md §4: errors are specific and actionable, never "Connection failed".
 * The server's hint is shown as a secondary detail when it adds information.
 */
function describeError(err, { host, port }) {
  if (!(err instanceof ApiError)) {
    return {
      title: 'Something unexpected went wrong on this machine.',
      detail: String(err && err.message ? err.message : err),
    };
  }
  switch (err.code) {
    case 'DEVICE_UNREACHABLE':
      return {
        title: `Nothing is listening on ${host}:${port}.`,
        // No hardcoded detail: the server's hint already explains this, and
        // duplicating it here printed the same advice twice in the error box.
        detail: null,
        hint: err.hint,
      };
    case 'DEVICE_TIMEOUT':
      return {
        title: `${host} did not answer in 10s.`,
        detail: 'Check the subnet/VLAN route between this machine and the camera.',
        hint: err.hint,
      };
    case 'UNAUTHORIZED':
      return {
        title: 'Device rejected those credentials.',
        detail: null,
        hint: err.hint,
      };
    case 'CLOCK_SKEW': {
      const match = /([\d.]+)\s*s/.exec(err.message || '');
      const n = match ? `${match[1]}s` : 'more than 60s';
      return {
        title: `Device clock is off by ${n}.`,
        detail: 'ONVIF digest auth will fail until NTP is fixed on the device.',
        hint: err.hint,
      };
    }
    case 'BAD_REQUEST':
      return { title: err.message, detail: err.hint || 'Check the host, port and credentials and try again.' };
    default:
      return {
        title: err.message || 'The device could not be reached.',
        detail: err.hint,
      };
  }
}

function loadRemembered() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data.host !== 'string') return null;
    return {
      host: data.host || '',
      port: String(data.port || 80),
      username: data.username || '',
    };
  } catch {
    return null;
  }
}

function saveRemembered({ host, port, username }) {
  // The password is never written anywhere.
  localStorage.setItem(REMEMBER_KEY, JSON.stringify({ host, port: Number(port), username }));
}

function clearRemembered() {
  localStorage.removeItem(REMEMBER_KEY);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Opt-in connect progress wire format (`Accept: application/x-ndjson`): one
 * JSON object per line. Profile events are
 * `{type:"progress", phase:"profiles", completed, total}` and the terminal
 * event is either `{type:"complete", session}` or `{type:"error", error}`.
 */
async function connectWithProgress(credentials, onProgress) {
  let response;
  try {
    response = await fetch('/api/connect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify(credentials),
    });
  } catch {
    throw new ApiError('DEVICE_UNREACHABLE', 'The controller server did not answer.',
      'Check that the server process is running on this machine.', 0);
  }

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    const err = data?.error ?? {};
    throw new ApiError(err.code || 'INTERNAL', err.message || `Request failed with status ${response.status}.`,
      err.hint ?? null, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let session = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'progress') onProgress(event);
      if (event.type === 'complete') session = event.session;
      if (event.type === 'error') {
        const err = event.error ?? {};
        throw new ApiError(err.code || 'INTERNAL', err.message || 'The device could not be reached.',
          err.hint ?? null, response.status);
      }
    }
    if (done) break;
  }
  if (!session) throw new ApiError('INTERNAL', 'The connect response ended before it completed.');
  return session;
}

/**
 * @param {HTMLElement} root
 * @param {{ onConnected: (session: object) => void, prefillError?: object|null }} opts
 * @returns {() => void} teardown
 */
export function renderConnect(root, { onConnected, prefillError = null }) {
  const remembered = loadRemembered();
  const cleanups = [];
  let destroyed = false;

  const screen = el('div', 'connect-screen');
  const card = el('div', 'connect-card');

  card.appendChild(el('h1', 'connect-title', 'ONVIF Controller'));
  card.appendChild(el('p', 'connect-subtitle', 'Connect to a camera on this network.'));

  // --- Fields ---
  const fields = {};
  const validators = {
    host: validateHost,
    port: validatePort,
    username: validateUsername,
    password: validatePassword,
  };

  function buildField(key, labelText, type, placeholder, initial) {
    const wrap = el('div', 'field');
    const label = el('label', 'field-label', labelText);
    const inputId = `connect-${key}`;
    label.htmlFor = inputId;
    const input = el('input', 'field-input');
    input.id = inputId;
    input.type = type;
    input.placeholder = placeholder;
    input.value = initial;
    input.autocomplete = key === 'password' ? 'current-password' : 'off';
    input.spellcheck = false;
    const error = el('p', 'field-error');
    error.hidden = true;
    wrap.append(label, input, error);
    fields[key] = { input, error, touched: false };
    return wrap;
  }

  const hostField = buildField('host', 'Host', 'text', '192.168.1.64', remembered ? remembered.host : '');
  const portField = buildField('port', 'Port', 'text', '80', remembered ? remembered.port : '80');
  const userField = buildField('username', 'Username', 'text', 'onvif', remembered ? remembered.username : '');
  const passField = buildField('password', 'Password', 'password', '••••••••', '');

  const hostPortRow = el('div', 'field-row');
  hostPortRow.append(hostField, portField);
  portField.style.flex = '0 0 6.5rem';

  // --- Remember toggle ---
  const rememberRow = el('label', 'toggle-row');
  const rememberInput = el('input', 'toggle-input');
  rememberInput.type = 'checkbox';
  rememberInput.checked = Boolean(remembered);
  rememberRow.append(rememberInput, el('span', 'toggle-label', 'Remember on this device'));
  const rememberNote = el('p', 'toggle-note', 'Stores host, port and username only — never the password.');

  // --- Connect button ---
  const connectBtn = el('button', 'btn btn-primary btn-block', 'Connect');
  connectBtn.type = 'button';
  cleanups.push(pressable(connectBtn));

  // --- Progress narrative ---
  const progress = el('ol', 'progress-stages');
  progress.hidden = true;
  const stageEls = STAGES.map((label) => {
    const li = el('li', 'stage');
    li.append(el('span', 'stage-dot'), el('span', 'stage-label', label));
    progress.appendChild(li);
    return li;
  });
  const stageLabels = stageEls.map((li) => li.querySelector('.stage-label'));

  // --- Error box ---
  const errorBox = el('div', 'error-box');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  function showError(err, ctx) {
    const { title, detail, hint } = describeError(err, ctx);
    errorBox.replaceChildren();
    errorBox.appendChild(el('p', 'error-title', title));
    const body = hint || detail;
    if (body) errorBox.appendChild(el('p', 'error-detail', body));
    errorBox.hidden = false;
  }

  if (prefillError) {
    const { title, detail, hint } = describeError(prefillError, { host: '', port: '' });
    errorBox.appendChild(el('p', 'error-title', title));
    const body = hint || detail;
    if (body) errorBox.appendChild(el('p', 'error-detail', body));
    errorBox.hidden = false;
  }

  // --- Discovery ---
  const discoverBtn = el('button', 'btn btn-ghost btn-block', 'Discover devices on this network');
  discoverBtn.type = 'button';
  cleanups.push(pressable(discoverBtn));
  const discoverStatus = el('p', 'discover-status');
  discoverStatus.hidden = true;
  const discoverList = el('div', 'discover-list');

  // --- Inline validation: as the user types, not on submit ---
  function validateField(key, { force = false } = {}) {
    const field = fields[key];
    if (!force && !field.touched) return true;
    const message = validators[key](field.input.value.trim());
    if (message) {
      field.error.textContent = message;
      field.error.hidden = false;
      field.input.classList.add('field-input-invalid');
      field.input.setAttribute('aria-invalid', 'true');
      return false;
    }
    field.error.hidden = true;
    field.input.classList.remove('field-input-invalid');
    field.input.removeAttribute('aria-invalid');
    return true;
  }

  for (const key of Object.keys(fields)) {
    const { input } = fields[key];
    const onInput = () => {
      fields[key].touched = true;
      validateField(key);
    };
    input.addEventListener('input', onInput);
    cleanups.push(() => input.removeEventListener('input', onInput));
  }

  function validateAll() {
    let ok = true;
    for (const key of Object.keys(fields)) {
      fields[key].touched = true;
      if (!validateField(key, { force: true })) ok = false;
    }
    return ok;
  }

  // --- Connect flow with the four-stage narrative ---
  let connecting = false;
  let stageTimers = [];

  function setStage(index, state) {
    const li = stageEls[index];
    li.classList.remove('stage-active', 'stage-done');
    if (state) li.classList.add(`stage-${state}`);
  }

  function resetStages() {
    stageTimers.forEach(clearTimeout);
    stageTimers = [];
    stageEls.forEach((li) => li.classList.remove('stage-active', 'stage-done'));
    stageLabels.forEach((label, index) => { label.textContent = STAGES[index]; });
  }

  async function handleConnect() {
    if (connecting) return;
    if (!validateAll()) return;
    connecting = true;
    errorBox.hidden = true;
    connectBtn.disabled = true;
    discoverBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    progress.hidden = false;
    resetStages();

    const host = fields.host.input.value.trim();
    const port = Number(fields.port.input.value.trim());
    const username = fields.username.input.value.trim();
    const password = fields.password.input.value;

    // Early ONVIF setup offers no incremental callback, so those stages remain
    // a narrative. The expensive final stage starts and advances only when the
    // server has actually enumerated the recorder's profiles.
    setStage(0, 'active');
    stageTimers.push(setTimeout(() => { setStage(0, 'done'); setStage(1, 'active'); }, 700));
    stageTimers.push(setTimeout(() => { setStage(1, 'done'); setStage(2, 'active'); }, 1600));

    try {
      const session = await connectWithProgress(
        { host, port, username, password },
        ({ completed, total }) => {
          if (destroyed) return;
          stageTimers.forEach(clearTimeout);
          stageTimers = [];
          setStage(0, 'done');
          setStage(1, 'done');
          setStage(2, 'done');
          setStage(3, completed === total && total > 0 ? 'done' : 'active');
          stageLabels[3].textContent = `Fetching profiles ${completed}/${total}`;
        },
      );
      if (destroyed) return;
      resetStages();
      stageEls.forEach((_, i) => setStage(i, 'done'));
      if (rememberInput.checked) saveRemembered({ host, port, username });
      else clearRemembered();
      // Let the user see the completed narrative for a beat before switching.
      setTimeout(() => {
        if (!destroyed) onConnected(session);
      }, 350);
    } catch (err) {
      if (destroyed) return;
      resetStages();
      progress.hidden = true;
      showError(err, { host, port });
    } finally {
      connecting = false;
      connectBtn.disabled = false;
      discoverBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  }

  // Commit on `click`, not `pointerup`. Visual feedback belongs on pointerdown
  // (see .btn:active), but binding the *action* to a pointer event means a
  // keyboard user pressing Enter or Space on the focused button — which fires
  // `click` and no pointer events at all — can never connect.
  connectBtn.addEventListener('click', handleConnect);
  cleanups.push(() => connectBtn.removeEventListener('click', handleConnect));

  // Enter key submits from any field.
  const onKeydown = (e) => {
    if (e.key === 'Enter') handleConnect();
  };
  card.addEventListener('keydown', onKeydown);
  cleanups.push(() => card.removeEventListener('keydown', onKeydown));

  // --- Discovery flow ---
  let discovering = false;
  async function handleDiscover() {
    if (discovering) return;
    discovering = true;
    discoverBtn.disabled = true;
    discoverList.replaceChildren();
    discoverStatus.textContent = 'Probing the network (5s)…';
    discoverStatus.hidden = false;
    try {
      const { devices } = await api.discover(5000);
      if (destroyed) return;
      if (!devices || devices.length === 0) {
        discoverStatus.textContent = 'No ONVIF devices answered. Check that this machine is on the same subnet.';
        return;
      }
      discoverStatus.textContent = `${devices.length} device${devices.length === 1 ? '' : 's'} found.`;
      for (const device of devices) {
        const row = el('button', 'discover-row');
        row.type = 'button';
        const name = el('span', 'discover-name', device.name || 'ONVIF device');
        const addr = el('span', 'discover-addr', `${device.host}:${device.port}`);
        row.append(name, addr);
        cleanups.push(pressable(row));
        const fill = () => {
          fields.host.input.value = device.host;
          fields.host.touched = true;
          fields.port.input.value = String(device.port);
          fields.port.touched = true;
          validateField('host');
          validateField('port');
          fields.username.input.focus();
        };
        row.addEventListener('click', fill);
        cleanups.push(() => row.removeEventListener('click', fill));
        discoverList.appendChild(row);
      }
    } catch (err) {
      if (destroyed) return;
      discoverStatus.textContent = err instanceof ApiError
        ? (err.hint || err.message)
        : 'Discovery failed on this machine.';
    } finally {
      discovering = false;
      discoverBtn.disabled = false;
    }
  }

  discoverBtn.addEventListener('click', handleDiscover);
  cleanups.push(() => discoverBtn.removeEventListener('click', handleDiscover));

  card.append(
    hostPortRow,
    userField,
    passField,
    rememberRow,
    rememberNote,
    connectBtn,
    progress,
    errorBox,
    el('hr', 'connect-divider'),
    discoverBtn,
    discoverStatus,
    discoverList,
  );
  screen.appendChild(card);
  root.appendChild(screen);

  return () => {
    destroyed = true;
    resetStages();
    cleanups.forEach((fn) => fn());
  };
}
