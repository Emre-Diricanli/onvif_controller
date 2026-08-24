const FIELD_LABELS = {
  hostname: 'Hostname', dhcp: 'DHCP', ipv4: 'IPv4 address', prefix: 'Prefix length',
  gateway: 'Default gateway', dns: 'DNS servers', ntp: 'NTP servers',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validIPv4(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every((part) =>
    Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part);
}

function validHost(value) {
  return value.length <= 253 && value.split('.').every((part) =>
    part.length > 0 && part.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part));
}

function splitList(value) {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

async function request(sessionId, method, body) {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/device/network`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, onError: (err: Error) => void }} opts
 * @returns {() => void}
 */
export function renderNetwork(container, { sessionId, onError }) {
  let destroyed = false;
  let baseline = null;
  const cleanups = [];
  const controls = new Map();
  const wrap = el('section', 'network');
  const status = el('p', 'network-status', 'Reading network settings…');
  const form = el('form', 'network-form');
  form.noValidate = true;
  wrap.append(status, form);
  container.appendChild(wrap);

  function report(err) {
    if (!destroyed && typeof onError === 'function') onError(err);
  }

  function field(name, label, input) {
    const row = el('div', `network-field network-field-${name}`);
    const labelEl = el('label', 'network-label', label);
    labelEl.htmlFor = input.id = `network-${name}`;
    const message = el('p', 'network-message');
    message.id = `${input.id}-message`;
    message.setAttribute('aria-live', 'polite');
    input.setAttribute('aria-describedby', message.id);
    row.append(labelEl, input, message);
    controls.set(name, { row, input, message });
    return row;
  }

  function input(type = 'text') {
    const node = el('input', 'network-input');
    node.type = type;
    node.autocomplete = 'off';
    node.spellcheck = false;
    return node;
  }

  function setMessage(name, message, kind = '') {
    const entry = controls.get(name);
    if (!entry) return;
    entry.message.textContent = message;
    entry.row.dataset.state = kind;
  }

  function validate(name) {
    const value = controls.get(name)?.input.value.trim() ?? '';
    let message = '';
    if (name === 'hostname' && (!value || !validHost(value))) message = 'Enter a non-empty hostname using letters, numbers, dots, or hyphens.';
    if ((name === 'ipv4' || name === 'gateway') && !validIPv4(value)) message = 'Enter a valid IPv4 address.';
    if (name === 'prefix' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 32)) message = 'Enter a prefix length from 1 to 32.';
    if (name === 'dns' || name === 'ntp') {
      const invalid = splitList(value).find((entry) => {
        const looksLikeIPv4 = /^\d+(?:\.\d+){3}$/.test(entry);
        return looksLikeIPv4 ? !validIPv4(entry) : !validHost(entry);
      });
      if (invalid) message = `“${invalid}” is not a valid IPv4 address or hostname.`;
    }
    setMessage(name, message, message ? 'invalid' : '');
    controls.get(name)?.input.setAttribute('aria-invalid', String(Boolean(message)));
    return !message;
  }

  function updateStaticState() {
    const disabled = controls.get('dhcp')?.input.checked ?? false;
    for (const name of ['ipv4', 'prefix', 'gateway']) {
      const entry = controls.get(name);
      if (entry) entry.input.disabled = disabled;
    }
  }

  function currentSettings() {
    return {
      hostname: controls.get('hostname').input.value.trim(),
      dhcp: controls.get('dhcp').input.checked,
      ipv4: controls.get('ipv4').input.value.trim(),
      prefix: Number(controls.get('prefix').input.value),
      gateway: controls.get('gateway').input.value.trim(),
      dns: splitList(controls.get('dns').input.value),
      ntp: splitList(controls.get('ntp').input.value),
    };
  }

  function changedSettings() {
    const current = currentSettings();
    const original = {
      hostname: baseline.hostname ?? '', dhcp: Boolean(baseline.dhcp),
      ipv4: baseline.interfaces?.[0]?.ipv4 ?? '', prefix: baseline.interfaces?.[0]?.prefix ?? 0,
      gateway: baseline.gateway ?? '', dns: baseline.dns ?? [], ntp: baseline.ntp ?? [],
    };
    return Object.fromEntries(Object.entries(current).filter(([name, value]) =>
      JSON.stringify(value) !== JSON.stringify(original[name])));
  }

  function render(data) {
    baseline = data;
    form.replaceChildren();
    controls.clear();
    const iface = data.interfaces?.[0] ?? {};
    const absent = data.hostname == null && !data.interfaces?.length && data.gateway == null &&
      !data.dns?.length && !data.ntp?.length;
    if (absent) {
      status.textContent = 'This device does not expose writable network configuration through ONVIF.';
      return;
    }
    status.hidden = true;

    const hostname = input(); hostname.value = data.hostname ?? '';
    const dhcp = input('checkbox'); dhcp.className = 'network-toggle'; dhcp.checked = Boolean(data.dhcp);
    const ipv4 = input(); ipv4.inputMode = 'decimal'; ipv4.value = iface.ipv4 ?? '';
    const prefix = input('number'); prefix.min = '1'; prefix.max = '32'; prefix.value = iface.prefix ?? '';
    const gateway = input(); gateway.inputMode = 'decimal'; gateway.value = data.gateway ?? '';
    const dns = el('textarea', 'network-input network-list'); dns.rows = 2; dns.value = (data.dns ?? []).join('\n');
    const ntp = el('textarea', 'network-input network-list'); ntp.rows = 2; ntp.value = (data.ntp ?? []).join('\n');
    form.append(
      field('hostname', 'Hostname', hostname), field('dhcp', 'Obtain address with DHCP', dhcp),
      field('ipv4', 'IPv4 address', ipv4), field('prefix', 'Prefix length', prefix),
      field('gateway', 'Default gateway', gateway), field('dns', 'DNS servers', dns),
      field('ntp', 'NTP servers', ntp),
    );
    for (const [name, entry] of controls) {
      const onInput = () => { validate(name); if (name === 'dhcp') updateStaticState(); };
      entry.input.addEventListener('input', onInput);
      cleanups.push(() => entry.input.removeEventListener('input', onInput));
    }
    updateStaticState();

    const actions = el('div', 'network-actions');
    const apply = el('button', 'network-apply', 'Apply network settings');
    apply.type = 'submit';
    const result = el('p', 'network-result'); result.setAttribute('aria-live', 'polite');
    actions.append(apply, result); form.append(actions);

    const submit = async (event) => {
      event.preventDefault();
      const patch = changedSettings();
      const names = Object.keys(patch);
      if (!names.length) { result.textContent = 'No settings have changed.'; return; }
      const valid = names.filter((name) => !(currentSettings().dhcp && ['ipv4', 'prefix', 'gateway'].includes(name)))
        .every((name) => validate(name));
      if (!valid) { result.textContent = 'Correct the highlighted fields before applying.'; return; }
      if (patch.dhcp === true) { delete patch.ipv4; delete patch.prefix; delete patch.gateway; }
      const relocating = ['dhcp', 'ipv4', 'prefix', 'gateway'].some((name) => name in patch);
      if (relocating) {
        const address = patch.dhcp === true ? 'an address assigned by DHCP' : (patch.ipv4 ?? iface.ipv4);
        const warning = `The camera will move to ${address} and this session will end. If the new address is wrong the camera may be unreachable and need a physical reset.`;
        if (!window.confirm(warning)) return;
      }
      apply.disabled = true;
      result.textContent = 'Applying and verifying with the camera…';
      for (const name of names) setMessage(name, '');
      try {
        const response = await request(sessionId, 'PATCH', { settings: patch });
        if (destroyed) return;
        for (const name of names) {
          if (response.applied?.[name] === false) {
            setMessage(name, 'The camera accepted the command and did not apply it.', 'refused');
          }
        }
        const refused = names.filter((name) => response.applied?.[name] === false);
        result.textContent = refused.length ? 'Some settings were not applied. Review the messages above.' : 'All changes were verified on the camera.';
        if (response.relocation?.expected) {
          result.textContent = response.relocation.address
            ? `The camera is expected at ${response.relocation.address}. This session has ended.`
            : 'The camera is switching to DHCP. This session has ended; discover it again to reconnect.';
          for (const entry of controls.values()) entry.input.disabled = true;
          apply.disabled = true;
          return;
        }
        baseline = response;
      } catch (err) {
        result.textContent = 'The network settings could not be applied.';
        report(err);
      } finally {
        if (!destroyed && !baseline?.relocation?.expected) apply.disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    cleanups.push(() => form.removeEventListener('submit', submit));
  }

  request(sessionId, 'GET').then((data) => { if (!destroyed) render(data); }).catch((err) => {
    if (destroyed) return;
    status.textContent = 'Network settings could not be read.';
    report(err);
  });

  return () => {
    destroyed = true;
    cleanups.splice(0).forEach((cleanup) => cleanup());
    wrap.remove();
  };
}
