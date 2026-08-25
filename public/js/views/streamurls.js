// views/streamurls.js — copyable stream URLs for VLC, ffmpeg, or an NVR.
//
// Credentials are deliberately opt-in. The sanitized URL renders by default and
// the credentialed one only appears when the operator asks for it, so a camera
// password is never sitting on screen during a screen-share by accident.

import { ApiError } from '../api.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Clipboard access needs a secure context. On plain http:// over a LAN — which
 * is exactly how this app is used — navigator.clipboard is undefined, so fall
 * back to a selection-based copy rather than showing a button that does nothing.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the manual path */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function renderStreamUrls(container, { sessionId, profile, onError }) {
  const cleanups = [];
  let destroyed = false;
  let showCredentials = false;

  const wrap = el('div', 'stream-urls');
  const status = el('p', 'panel-status', 'Reading stream URLs…');
  wrap.appendChild(status);

  const list = el('div', 'stream-url-list');
  wrap.appendChild(list);

  const credRow = el('div', 'stream-url-credrow');
  const credToggle = el('button', 'btn btn-ghost btn-sm', 'Show credentials');
  credToggle.type = 'button';
  credToggle.setAttribute('aria-pressed', 'false');
  const credNote = el('p', 'stream-url-note',
    'Hidden by default so a camera password is not left on screen. Revealing it fetches the URL with the username and password embedded.');
  credRow.append(credToggle, credNote);

  function row(entry, duplicateMetadata) {
    const item = el('div', 'stream-url-item');

    const head = el('div', 'stream-url-head');
    const name = entry.name || entry.token;
    head.appendChild(el('span', 'stream-url-name',
      duplicateMetadata ? `${name} (${entry.token})` : name));
    const meta = [entry.codec, entry.resolution].filter(Boolean).join(' · ');
    if (meta) head.appendChild(el('span', 'stream-url-meta', meta));
    item.appendChild(head);

    const shown = showCredentials && entry.rtspWithCredentials
      ? entry.rtspWithCredentials
      : entry.rtsp;

    if (shown) item.appendChild(field('RTSP', shown));
    if (entry.snapshot) item.appendChild(field('Snapshot', entry.snapshot));
    return item;
  }

  function field(label, value) {
    const f = el('div', 'stream-url-field');
    f.appendChild(el('span', 'control-label', label));

    const box = el('div', 'stream-url-box');
    const input = el('input', 'stream-url-input');
    input.type = 'text';
    input.readOnly = true;
    input.value = value;
    input.setAttribute('aria-label', `${label} URL`);
    // Select the whole URL on focus so keyboard copy is one gesture.
    const onFocus = () => input.select();
    input.addEventListener('focus', onFocus);
    cleanups.push(() => input.removeEventListener('focus', onFocus));

    const btn = el('button', 'btn btn-ghost btn-sm stream-url-copy', 'Copy');
    btn.type = 'button';
    const onCopy = async () => {
      const ok = await copyText(value);
      btn.textContent = ok ? 'Copied' : 'Press ⌘C';
      if (!ok) input.select();
      setTimeout(() => { if (!destroyed) btn.textContent = 'Copy'; }, 1600);
    };
    btn.addEventListener('click', onCopy);
    cleanups.push(() => btn.removeEventListener('click', onCopy));

    box.append(input, btn);
    f.appendChild(box);
    return f;
  }

  async function load() {
    try {
      // api.getStreamUrls predates channel selection, so use the same API error
      // envelope while including the profile the controller already supplies.
      const params = new URLSearchParams({ profile });
      if (showCredentials) params.set('credentials', 'true');
      const response = await fetch(`/api/session/${encodeURIComponent(sessionId)}/stream-urls?${params}`);
      const res = await response.json();
      if (!response.ok) {
        const error = res?.error ?? {};
        throw new ApiError(error.code || 'INTERNAL',
          error.message || `Request failed with status ${response.status}.`,
          error.hint ?? null, response.status);
      }
      if (destroyed) return;
      list.replaceChildren();
      if (!res.urls || res.urls.length === 0) {
        status.textContent = 'This device did not report any stream or snapshot URLs.';
        status.hidden = false;
        credRow.hidden = true;
        return;
      }
      status.hidden = true;
      credRow.hidden = false;
      const metadataCounts = new Map();
      for (const entry of res.urls) {
        const key = JSON.stringify([entry.name || entry.token, entry.codec, entry.resolution]);
        metadataCounts.set(key, (metadataCounts.get(key) ?? 0) + 1);
      }
      for (const entry of res.urls) {
        const key = JSON.stringify([entry.name || entry.token, entry.codec, entry.resolution]);
        list.appendChild(row(entry, metadataCounts.get(key) > 1));
      }
      if (!wrap.contains(credRow)) wrap.appendChild(credRow);
    } catch (err) {
      if (destroyed) return;
      status.hidden = false;
      status.textContent = err instanceof ApiError
        ? `${err.message}${err.hint ? ` ${err.hint}` : ''}`
        : 'Could not read the stream URLs.';
      if (onError) onError(err);
    }
  }

  const onToggle = () => {
    showCredentials = !showCredentials;
    credToggle.textContent = showCredentials ? 'Hide credentials' : 'Show credentials';
    credToggle.setAttribute('aria-pressed', String(showCredentials));
    load();
  };
  credToggle.addEventListener('click', onToggle);
  cleanups.push(() => credToggle.removeEventListener('click', onToggle));

  container.appendChild(wrap);
  load();

  return () => {
    destroyed = true;
    for (const fn of cleanups) { try { fn(); } catch { /* teardown must not throw */ } }
    wrap.remove();
  };
}
