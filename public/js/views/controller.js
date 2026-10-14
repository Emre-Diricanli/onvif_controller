// views/controller.js — the main shell.
//
// The video is the hero surface; controls live in a persistent translucent
// sidebar (a draggable bottom sheet on narrow screens). EVERY section the app
// knows how to render is listed, so the operator can see the whole surface of
// the tool; a section the device cannot support renders a stated reason in
// place of its controls, never a disabled clone of them (UI-AVAILABILITY.md).
// Multiple sections may remain open.
// Nothing here is optimistic: every state shown comes from the player, the
// WebSocket, or a completed API call.
//
// Multi-source recorders (DVR/NVR): the top overlay gains a channel strip — a
// horizontal radiogroup of channel-number buttons next to the profile
// switcher; per-source sections (PTZ, Presets, Imaging, Video, Stream URLs)
// are scoped to the selected channel, echo its label in their headings, and
// are gated by that channel's own capability flags; device-wide sections
// (Events, Device, Network, Capabilities) sit behind a divider that marks
// them as applying to the whole recorder. A single-source device skips all of
// this and renders exactly the layout described above.

import { createPlayer } from '../player.js';
import { api, ApiError } from '../api.js';
import { spring, project, rubberband, prefersReducedMotion } from '../spring.js';
import { draggable, pressable } from '../gesture.js';
import { renderJoystick } from './joystick.js';
import { renderPresets } from './presets.js';
import { renderImaging } from './imaging.js';
import { renderEvents } from './events.js';
import { renderStreamUrls } from './streamurls.js';
import { renderNetwork } from './network.js';
import { renderEncoder } from './encoder.js';
import { renderPlayback } from './playback.js';
import { renderFanout } from './fanout.js';
import { renderSettings } from './settings.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const PLAYER_STATE_LABEL = {
  idle: ['Idle', 'bad'],
  connecting: ['Connecting', 'warn'],
  playing: ['Live', 'ok'],
  reconnecting: ['Reconnecting', 'warn'],
  degraded: ['Degraded — snapshots', 'warn'],
  error: ['Stream error', 'bad'],
};

// ---------------------------------------------------------------------------
// Device panel (info, network, time, relays, reboot) — small enough to live
// in the shell rather than its own file.
// ---------------------------------------------------------------------------
function renderDevice(container, { sessionId, onError }) {
  let destroyed = false;
  const cleanups = [];

  const wrap = el('div', 'device');
  const status = el('p', 'panel-status', 'Reading device info…');
  const body = el('div', 'device-body');
  wrap.append(status, body);
  container.appendChild(wrap);

  function section(title) {
    const s = el('section', 'device-section');
    s.appendChild(el('h3', 'device-heading', title));
    body.appendChild(s);
    return s;
  }
  function kv(parent, key, value) {
    if (value == null || value === '') return;
    const row = el('div', 'kv-row');
    row.append(el('span', 'kv-key', key), el('span', 'kv-value', String(value)));
    parent.appendChild(row);
  }

  api.getDevice(sessionId).then((data) => {
    if (destroyed) return;
    status.hidden = true;

    const info = section('Device');
    kv(info, 'Model', [data.info.manufacturer, data.info.model].filter(Boolean).join(' '));
    kv(info, 'Firmware', data.info.firmware);
    kv(info, 'Serial', data.info.serial);
    kv(info, 'Hardware ID', data.info.hardwareId);

    if (data.network) {
      const net = section('Network');
      kv(net, 'Hostname', data.network.hostname);
      kv(net, 'DHCP', data.network.dhcp ? 'On' : 'Off');
      for (const iface of data.network.interfaces || []) {
        kv(net, iface.name || 'Interface', [iface.ipv4, iface.prefix != null ? `/${iface.prefix}` : '', iface.mac ? `(${iface.mac})` : ''].filter(Boolean).join(' '));
      }
      kv(net, 'Gateway', data.network.gateway);
      kv(net, 'DNS', (data.network.dns || []).join(', '));
      kv(net, 'NTP', (data.network.ntp || []).join(', '));
    }

    if (data.time) {
      const time = section('Time');
      kv(time, 'Device time', data.time.deviceTime ? new Date(data.time.deviceTime).toLocaleString() : null);
      kv(time, 'Timezone', data.time.timezone);
      kv(time, 'NTP enabled', data.time.ntpEnabled ? 'Yes' : 'No');
      if (typeof data.time.skewSeconds === 'number') {
        const skew = Math.abs(data.time.skewSeconds);
        kv(time, 'Clock skew', `${skew.toFixed(1)}s${skew > 60 ? ' — digest auth will fail until NTP is fixed' : ''}`);
      }
      const syncBtn = el('button', 'btn btn-ghost btn-sm', 'Sync device clock to this machine');
      syncBtn.type = 'button';
      cleanups.push(pressable(syncBtn));
      const sync = () => {
        syncBtn.disabled = true;
        api.syncTime(sessionId)
          .then(() => { if (!destroyed) { syncBtn.textContent = 'Clock synced'; } })
          .catch((err) => { onError(err); if (!destroyed) { syncBtn.disabled = false; } });
      };
      syncBtn.addEventListener('click', sync);
      cleanups.push(() => syncBtn.removeEventListener('click', sync));
      time.appendChild(syncBtn);
    }

    if (Array.isArray(data.relayOutputs) && data.relayOutputs.length > 0) {
      const relays = section('Relay outputs');
      for (const relay of data.relayOutputs) {
        const row = el('div', 'relay-row');
        const name = el('span', 'kv-key', relay.token);
        const btn = el('button', 'btn btn-ghost btn-sm');
        btn.type = 'button';
        const render = (state) => {
          btn.textContent = state === 'active' ? 'Active — tap to open' : 'Inactive — tap to close';
          btn.classList.toggle('relay-active', state === 'active');
        };
        render(relay.state);
        cleanups.push(pressable(btn));
        const toggle = () => {
          const next = relay.state === 'active' ? 'inactive' : 'active';
          btn.disabled = true;
          api.setRelay(sessionId, relay.token, next)
            .then(() => { relay.state = next; if (!destroyed) render(next); })
            .catch(onError)
            .finally(() => { if (!destroyed) btn.disabled = false; });
        };
        btn.addEventListener('click', toggle);
        cleanups.push(() => btn.removeEventListener('click', toggle));
        row.append(name, btn);
        relays.appendChild(row);
      }
    }

    const danger = section('Maintenance');
    const rebootBtn = el('button', 'btn btn-danger btn-sm', 'Reboot device');
    rebootBtn.type = 'button';
    cleanups.push(pressable(rebootBtn));
    let confirming = false;
    const reboot = () => {
      if (!confirming) {
        confirming = true;
        rebootBtn.textContent = 'Confirm reboot — the stream will drop';
        const cancel = (e) => {
          if (rebootBtn.contains(e.target)) return;
          confirming = false;
          rebootBtn.textContent = 'Reboot device';
          document.removeEventListener('pointerdown', cancel, true);
        };
        document.addEventListener('pointerdown', cancel, true);
        cleanups.push(() => document.removeEventListener('pointerdown', cancel, true));
        return;
      }
      confirming = false;
      rebootBtn.disabled = true;
      api.reboot(sessionId)
        .then((res) => { if (!destroyed) rebootBtn.textContent = (res && res.message) || 'Reboot command accepted.'; })
        .catch((err) => {
          onError(err);
          if (!destroyed) { rebootBtn.disabled = false; rebootBtn.textContent = 'Reboot device'; }
        });
    };
    rebootBtn.addEventListener('click', reboot);
    cleanups.push(() => rebootBtn.removeEventListener('click', reboot));
    danger.appendChild(rebootBtn);
  }).catch((err) => {
    if (destroyed) return;
    status.textContent = 'Device info could not be read.';
    onError(err);
  });

  return {
    el: wrap,
    destroy() { destroyed = true; cleanups.forEach((fn) => fn()); },
  };
}

function renderCapabilities(container, { session }) {
  const wrap = el('div', 'caps');
  wrap.appendChild(el('p', 'panel-status', 'What this device actually supports.'));
  const table = el('div', 'caps-grid');
  const caps = session.capabilities || {};
  const rows = [
    ['Media', caps.media],
    ['Media2 (Profile T)', caps.media2],
    ['PTZ', caps.ptz],
    ['Imaging', caps.imaging],
    ['Events', caps.events],
    ['Analytics', caps.analytics],
    ['Recording', caps.recording],
    ['Audio backchannel', caps.audioBackchannel],
    ['Relay outputs', caps.relayOutputs > 0 ? String(caps.relayOutputs) : false],
  ];
  for (const [label, value] of rows) {
    const row = el('div', 'caps-row');
    const yes = Boolean(value);
    row.append(
      el('span', 'kv-key', label),
      el('span', `caps-value ${yes ? 'caps-yes' : 'caps-no'}`, yes ? (typeof value === 'string' ? value : 'Yes') : 'No'),
    );
    table.appendChild(row);
  }
  if (session.ptz) {
    const extra = el('div', 'caps-row');
    extra.append(
      el('span', 'kv-key', 'PTZ extras'),
      el('span', 'caps-value caps-yes', [
        session.ptz.presetsSupported ? 'presets' : null,
        session.ptz.toursSupported ? 'tours' : null,
        session.ptz.homeSupported ? 'home' : null,
      ].filter(Boolean).join(', ') || 'basic move only'),
    );
    table.appendChild(extra);
  }
  wrap.appendChild(table);
  container.appendChild(wrap);
  return { el: wrap, destroy() {} };
}

const SIDEBAR_STATE_KEY = 'onvif-controller-sidebar-v1';

function readSidebarState() {
  try {
    const value = JSON.parse(localStorage.getItem(SIDEBAR_STATE_KEY));
    return {
      collapsed: Boolean(value?.collapsed),
      expanded: new Set(Array.isArray(value?.expanded) ? value.expanded : ['PTZ', 'Imaging']),
    };
  } catch {
    return { collapsed: false, expanded: new Set(['PTZ', 'Imaging']) };
  }
}

function writeSidebarState(state) {
  try {
    localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify({
      collapsed: state.collapsed,
      expanded: [...state.expanded],
    }));
  } catch { /* storage may be disabled; state still lasts for this mount */ }
}

/**
 * Why a panel cannot be used on this device, in the device's own terms.
 *
 * Every string here describes something we OBSERVED — a service the device did
 * not advertise, a node it did not report. Never assert a cause we did not see:
 * we already shipped and fixed one bug that blamed "Hikvision firmware" on a
 * device that had refused to identify itself, and the operator caught it.
 *
 * `def.reason` may be a string or a function of the current source, so a
 * channel-scoped section can name the channel it is talking about.
 */
function reasonFor(def, state) {
  const source = state?.currentSource ?? null;
  const raw = typeof def.reason === 'function' ? def.reason(source) : def.reason;
  return raw || 'This device does not report support for this feature.';
}

/**
 * The body of an unavailable section: prose, never controls.
 *
 * Deliberately renders no inputs at all. A greyed-out slider reads as "the app
 * is broken"; a sentence reads as "the camera cannot do this", which is the
 * truth and is actionable.
 */
function renderUnavailable(container, reason) {
  const note = el('p', 'sidebar-unavailable-note', reason);
  container.appendChild(note);
  return { destroy() { note.remove(); } };
}

class SidebarSections {
  constructor(host, definitions, state, cleanups) {
    this.host = host;
    this.definitions = definitions;
    this.state = state;
    this.cleanups = cleanups;
    this.entries = new Map();
    this.build();
  }

  build() {
    for (const def of this.definitions) {
      // Every panel the app knows how to render is listed, so the operator can
      // see the tool's whole surface and never has to wonder whether a feature
      // is missing because the device lacks it or because it was never built.
      // An unsupported panel renders its reason instead of its controls — never
      // a disabled clone of the real thing (SPEC.md §4, UI-AVAILABILITY.md).
      const unavailable = def.available() ? null : reasonFor(def, this.state);
      const section = el('section', 'sidebar-section');
      if (unavailable) section.classList.add('sidebar-section-unavailable');
      const heading = el('h2', 'sidebar-section-heading');
      const button = el('button', 'sidebar-section-toggle');
      button.type = 'button';
      const id = `sidebar-section-${def.name.toLowerCase()}`;
      // def.heading overrides the visible label (multi-channel sections echo
      // the channel they act on); def.name stays the stable persistence key.
      const label = el('span', 'sidebar-section-label', def.heading || def.name);
      button.appendChild(label);
      if (unavailable) {
        // A tag rather than a colour alone: colour is not available to every
        // reader, and "Unavailable" is unambiguous.
        button.appendChild(el('span', 'sidebar-section-tag', 'Unavailable'));
      }
      const chevron = el('span', 'sidebar-section-chevron', '⌄');
      chevron.setAttribute('aria-hidden', 'true');
      button.appendChild(chevron);
      heading.appendChild(button);
      const content = el('div', 'sidebar-section-content');
      content.id = id;
      button.setAttribute('aria-controls', id);
      // An unavailable section always starts collapsed, whatever was persisted:
      // restoring it open would push the working panels down the column.
      const open = !unavailable && this.state.expanded.has(def.name);
      button.setAttribute('aria-expanded', String(open));
      content.hidden = !open;
      section.classList.toggle('sidebar-section-open', open);
      section.append(heading, content);
      this.host.appendChild(section);
      // build() is never called for an unavailable section, so it cannot issue
      // a request or mount a control that would fail against this device.
      const view = unavailable ? renderUnavailable(content, unavailable) : def.build(content);
      const entry = { def, section, button, content, view, spring: null, value: open ? 1 : 0 };
      this.entries.set(def.name, entry);
      this.cleanups.push(pressable(button, { scale: 0.985 }));
      const toggle = () => this.setOpen(entry, !this.state.expanded.has(def.name));
      button.addEventListener('click', toggle);
      this.cleanups.push(() => button.removeEventListener('click', toggle));
      // Arrow keys rove focus between section headers (visual order = DOM
      // order); Escape collapses the focused section. Focus is never moved
      // anywhere it cannot Tab out of — no trapping.
      const onKeyDown = (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const toggles = [...this.host.querySelectorAll('.sidebar-section-toggle')];
          const index = toggles.indexOf(button);
          if (index === -1) return;
          const next = e.key === 'ArrowDown'
            ? toggles[(index + 1) % toggles.length]
            : toggles[(index - 1 + toggles.length) % toggles.length];
          next.focus();
        } else if (e.key === 'Escape' && this.state.expanded.has(def.name)) {
          e.preventDefault();
          this.setOpen(entry, false);
        }
      };
      button.addEventListener('keydown', onKeyDown);
      this.cleanups.push(() => button.removeEventListener('keydown', onKeyDown));
    }
  }

  setOpen(entry, open, immediate = false) {
    if (open) this.state.expanded.add(entry.def.name);
    else this.state.expanded.delete(entry.def.name);
    writeSidebarState(this.state);
    entry.button.setAttribute('aria-expanded', String(open));
    entry.section.classList.toggle('sidebar-section-open', open);
    if (entry.spring) entry.spring.stop();
    if (open) entry.content.hidden = false;

    const apply = (value) => {
      entry.value = value;
      entry.content.style.opacity = String(value);
      entry.content.style.transform = prefersReducedMotion()
        ? 'none'
        : `translateY(${(1 - value) * -8}px) scale(${0.985 + value * 0.015})`;
    };
    const finish = () => {
      entry.spring = null;
      if (!open) entry.content.hidden = true;
      entry.content.style.opacity = '';
      entry.content.style.transform = '';
    };
    if (immediate) { apply(open ? 1 : 0); finish(); return; }
    entry.spring = spring({
      from: entry.value,
      to: open ? 1 : 0,
      damping: 1.0,
      response: prefersReducedMotion() ? 0.2 : 0.35,
      onUpdate: apply,
      onComplete: finish,
    });
  }

  rebuildViews() {
    for (const entry of this.entries.values()) {
      entry.view?.destroy?.();
      entry.content.replaceChildren();
      entry.view = entry.def.build(entry.content);
    }
  }

  destroy() {
    for (const entry of this.entries.values()) {
      entry.spring?.stop();
      entry.view?.destroy?.();
    }
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Controller shell
// ---------------------------------------------------------------------------
/**
 * @param {HTMLElement} root
 * @param {{ session: object, onDisconnect: (reason?: object) => void }} opts
 * @returns {() => void} teardown
 */
export function renderController(root, { session, onDisconnect }) {
  const cleanups = [];
  let destroyed = false;

  // One connection may front many video sources (DVR/NVR channels). `sources`
  // is always present on the session — length 1 for a normal camera — so the
  // data path never branches; only the layout branches on isMultiChannel.
  // Guard on the payload itself so a session without sources can never half-
  // render the channel-scoped layout.
  const sources = Array.isArray(session.sources) ? session.sources : [];
  const isMultiChannel = Boolean(session.isMultiChannel) && sources.length > 1;
  let currentSource = sources[0] || null;
  const channelLabel = (source) =>
    source.label || `Channel ${sources.indexOf(source) + 1}`;
  const currentProfiles = () => {
    const list = currentSource ? currentSource.profiles : session.profiles;
    return Array.isArray(list) ? list : [];
  };
  const initialProfiles = currentProfiles();
  let currentProfile = initialProfiles.length > 0 ? initialProfiles[0].token : null;

  const shell = el('div', 'controller');

  // --- Video surface ---
  const stage = el('div', 'stage-video');
  const video = document.createElement('video');
  video.className = 'player-video';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  stage.appendChild(video);

  // SPEC.md §5/§7: degrade visibly. An empty black rectangle reads as "the app
  // is broken"; say what is wrong, what it means, and offer the way out.
  const stageMessage = el('div', 'stage-message');
  const stageMessageTitle = el('p', 'stage-message-title', '');
  const stageMessageBody = el('p', 'stage-message-body', '');
  const stageRetry = el('button', 'btn btn-primary btn-sm', 'Try again');
  stageRetry.type = 'button';
  stageMessage.append(stageMessageTitle, stageMessageBody, stageRetry);
  stageMessage.hidden = true;
  stage.appendChild(stageMessage);

  function showStageMessage(title, body, { retry = true } = {}) {
    stageMessageTitle.textContent = title;
    stageMessageBody.textContent = body ?? '';
    stageMessageBody.hidden = !body;
    stageRetry.hidden = !retry;
    stageMessage.hidden = false;
  }
  function hideStageMessage() {
    stageMessage.hidden = true;
  }

  // --- Top overlay: profile switcher, stats, connection state ---
  const topBar = el('div', 'overlay overlay-top');

  const connState = el('span', 'conn-state');
  const connDot = el('span', 'conn-dot');
  const connLabel = el('span', 'conn-label', 'Connecting');
  connState.append(connDot, connLabel);

  const stats = el('span', 'stream-stats');
  stats.hidden = true;

  topBar.append(connState, stats);

  let profileSegmented = null;

  // The switcher lists the current channel's profiles — one or two on a
  // recorder, so it stays a compact segmented control. Rebuilt on channel
  // change; a single-source device builds it once, exactly as before.
  function buildProfileSwitcher() {
    if (profileSegmented) {
      profileSegmented.remove();
      profileSegmented = null;
    }
    const profiles = currentProfiles();
    if (profiles.length <= 1) return;
    profileSegmented = el('div', 'segmented profile-switcher');
    profileSegmented.setAttribute('role', 'group');
    profileSegmented.setAttribute('aria-label', 'Stream profile');
    for (const p of profiles) {
      const btn = el('button', 'segment', p.name || p.token);
      btn.type = 'button';
      btn.dataset.token = p.token;
      if (p.token === currentProfile) btn.classList.add('segment-active');
      cleanups.push(pressable(btn, { scale: 0.94 }));
      const switchProfile = () => {
        if (destroyed || btn.disabled || p.token === currentProfile) return;
        selectProfile(p.token);
      };
      btn.addEventListener('click', switchProfile);
      cleanups.push(() => btn.removeEventListener('click', switchProfile));
      profileSegmented.appendChild(btn);
    }
    topBar.appendChild(profileSegmented);
  }

  // Channel strip — multi-source recorders only. A horizontal radiogroup of
  // channel-NUMBER buttons in the top overlay, next to the profile switcher.
  // Numbers only: on a 16- or 32-channel recorder digits stay scannable where
  // 'Channel 15' labels would not — the full label lives in the per-channel
  // section headings. The strip scrolls horizontally and never wraps, so many
  // channels cannot grow into a block that eats the picture. The active
  // channel is rendered unmistakable in CSS; misreading it is the failure the
  // whole multi-channel feature exists to prevent. A single-source device
  // builds no strip at all, exactly as before.
  let channelStrip = null;
  let channelButtons = [];

  function paintChannelStrip(index) {
    channelButtons.forEach((btn, i) => {
      const active = i === index;
      btn.classList.toggle('channel-btn-active', active);
      btn.setAttribute('aria-checked', String(active));
      btn.tabIndex = active ? 0 : -1;
    });
    // Programmatic changes (including arrow-key moves) keep the active button
    // visible inside the horizontally scrolling strip.
    const activeBtn = channelButtons[index];
    if (activeBtn) {
      activeBtn.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }

  function buildChannelStrip() {
    if (!isMultiChannel) return;
    channelStrip = el('div', 'channel-strip');
    channelStrip.setAttribute('role', 'radiogroup');
    channelStrip.setAttribute('aria-label', 'Channel');
    sources.forEach((source, index) => {
      const btn = el('button', 'channel-btn', String(index + 1));
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      // A bare digit is not an accessible name; announce the channel it
      // switches to. aria-checked announces which one is current.
      btn.setAttribute('aria-label', channelLabel(source));
      cleanups.push(pressable(btn, { scale: 0.92 }));
      // Commit on click, never on pointerup — the pointerup-commit regression
      // was fixed once and must not return.
      const pick = () => {
        if (destroyed) return;
        selectChannel(index);
      };
      btn.addEventListener('click', pick);
      cleanups.push(() => btn.removeEventListener('click', pick));
      // Radiogroup keyboard behaviour: arrows move the selection itself and
      // focus follows it (wrapping at the ends); Home/End jump to the edges.
      // Roving tabindex means Tab enters on the current channel and always
      // leaves the group — no focus trap.
      const onKeyDown = (e) => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % sources.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + sources.length) % sources.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = sources.length - 1;
        if (next === null) return;
        e.preventDefault();
        channelButtons[next].focus();
        selectChannel(next);
      };
      btn.addEventListener('keydown', onKeyDown);
      cleanups.push(() => btn.removeEventListener('keydown', onKeyDown));
      channelButtons.push(btn);
      channelStrip.appendChild(btn);
    });
    paintChannelStrip(sources.indexOf(currentSource));
    topBar.appendChild(channelStrip);
  }

  // Strip first, then the profile switcher, so the switcher stays the
  // rightmost control in the overlay exactly as it is today. On channel
  // change buildProfileSwitcher() re-appends the switcher at the end, which
  // keeps this order.
  buildChannelStrip();
  buildProfileSwitcher();

  stage.appendChild(topBar);

  // --- Error toast ---
  const toast = el('div', 'toast');
  toast.setAttribute('role', 'alert');
  toast.hidden = true;
  let toastTimer = null;
  let toastSpring = null;

  function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastSpring) toastSpring.stop();
    toastSpring = spring({
      from: 1, to: 0, response: 0.25,
      onUpdate: (v) => { toast.style.opacity = String(v); },
      onComplete: () => { toast.hidden = true; toast.style.opacity = ''; },
    });
  }

  function showError(err) {
    if (destroyed) return;
    if (err instanceof ApiError && err.code === 'SESSION_EXPIRED') {
      teardownToConnect(err);
      return;
    }
    const title = err instanceof ApiError ? err.message : 'Something went wrong.';
    const hint = err instanceof ApiError ? err.hint : null;
    toast.replaceChildren(el('p', 'toast-title', title));
    if (hint) toast.appendChild(el('p', 'toast-hint', hint));
    toast.hidden = false;
    toast.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  stage.appendChild(toast);
  shell.appendChild(stage);

  const ctx = () => ({
    sessionId: session.sessionId,
    profile: currentProfile,
    ptz: session.ptz,
    session,
    onError: showError,
  });

  // scope: 'source' sections act on the selected channel; on a multi-source
  // recorder they are rebuilt per channel, additionally gated by that
  // channel's own flags via availableOn (a channel with no PTZ renders no PTZ
  // section — absent, never disabled, SPEC.md §4), and echo the channel label
  // in their headings. scope: 'device' sections act on the whole recorder and
  // are visually separated from the channel-scoped ones. On a single-source
  // device scope and availableOn change nothing: the sections render exactly
  // as they always have.
  const PANEL_DEFS = [
    {
      name: 'PTZ',
      scope: 'source',
      available: () => Boolean(session.capabilities && session.capabilities.ptz && session.ptz),
      availableOn: (source) => source.ptzSupported !== false,
      reason: () => (session.capabilities && session.capabilities.ptz
        ? 'This device advertises PTZ but reports no movable node, so there is nothing to drive.'
        : 'This device does not advertise the ONVIF PTZ service. It is most likely a fixed camera.'),
      reasonOnChannel: (label) => `${label} reports no PTZ node. Other channels on this recorder may still be movable.`,
      build: (c) => renderJoystick(c, { ...ctx() }),
    },
    {
      name: 'Presets',
      scope: 'source',
      available: () => Boolean(session.capabilities && session.capabilities.ptz && session.ptz && session.ptz.presetsSupported),
      availableOn: (source) => source.ptzSupported !== false,
      reason: () => (session.capabilities && session.capabilities.ptz && session.ptz
        ? 'This device has PTZ but does not report preset support.'
        : 'Presets need PTZ, and this device does not advertise the ONVIF PTZ service.'),
      reasonOnChannel: (label) => `${label} reports no PTZ, so it has no presets.`,
      build: (c) => renderPresets(c, { ...ctx() }),
    },
    {
      name: 'Imaging',
      scope: 'source',
      available: () => Boolean(session.capabilities && session.capabilities.imaging),
      availableOn: (source) => source.imagingSupported !== false,
      reason: 'This device does not advertise the ONVIF Imaging service, so brightness, contrast and exposure cannot be adjusted from here.',
      reasonOnChannel: (label) => `${label} reports no imaging source. Other channels on this recorder may still be adjustable.`,
      build: (c) => renderImaging(c, { ...ctx() }),
    },
    {
      name: 'Events',
      scope: 'device',
      available: () => Boolean(session.capabilities && session.capabilities.events),
      reason: 'This device does not advertise the ONVIF Events service, so it cannot report motion or tamper detections.',
      build: (c) => renderEvents(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Video',
      scope: 'source',
      // Any profile with an encoder configuration can be reconfigured.
      available: () => Array.isArray(session.profiles) && session.profiles.length > 0,
      availableOn: (source) => Array.isArray(source.profiles) && source.profiles.length > 0,
      build: (c) => renderEncoder(c, {
        sessionId: session.sessionId,
        profile: currentProfile,
        onError: showError,
        onApplied: (response) => {
          // The encoder changed under the running pipeline. The server has
          // already torn it down; rebuild the client side from a fresh init
          // segment rather than letting MSE reject every incoming fragment.
          if (response?.streamRestartRequired && currentProfile) {
            player.stop();
            player.start(currentProfile).catch((err) => showError(
              err instanceof ApiError ? err : new ApiError('STREAM_FAILED', String(err)),
            ));
          }
        },
      }),
    },
    {
      name: 'Stream URLs',
      scope: 'source',
      // Anything with a media profile has something worth copying.
      available: () => Array.isArray(session.profiles) && session.profiles.length > 0,
      availableOn: (source) => Array.isArray(source.profiles) && source.profiles.length > 0,
      build: (c) => renderStreamUrls(c, { sessionId: session.sessionId, profile: currentProfile, onError: showError }),
    },
    {
      name: 'Playback',
      scope: 'device',
      // Profile G. The capability matrix carries `recording` from GetServices;
      // replay without recording still means there is something to look at.
      available: () => Boolean(session.capabilities
        && (session.capabilities.recording || session.capabilities.replay)),
      reason: 'This device advertises no ONVIF Recording, Replay or Search service, so recorded footage cannot be reached over ONVIF. Its own client software may still be able to play it back.',
      build: (c) => renderPlayback(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Fan-out',
      scope: 'device',
      // Fan-out is a property of the server, not the camera: it is available
      // whenever the operator configured targets, on any device.
      available: () => true,
      build: (c) => renderFanout(c, { onError: showError }),
    },
    {
      name: 'All settings',
      scope: 'device',
      // The protocol-neutral surface: every target the device declares, in
      // its own units, with per-field outcomes. Works on any adapter.
      available: () => true,
      build: (c) => renderSettings(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Device',
      scope: 'device',
      available: () => true,
      build: (c) => renderDevice(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Network',
      scope: 'device',
      // Every ONVIF device answers the device service; the view itself reports
      // when a particular camera exposes nothing writable.
      available: () => true,
      build: (c) => renderNetwork(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Capabilities',
      scope: 'device',
      available: () => true,
      build: (c) => renderCapabilities(c, { session }),
    },
  ];

  // Multi-channel: split the definitions into the two scopes. Channel-scoped
  // sections are gated by the selected channel's flags and echo its label in
  // their headings, so the scope of an edit is visible at all times. The defs
  // are re-derived on every channel change, so they always close over the
  // current channel.
  const scopedPanelDefs = (scope) => PANEL_DEFS
    .filter((def) => def.scope === scope)
    .map((def) => ({
      ...def,
      heading: scope === 'source' ? `${def.name} — ${channelLabel(currentSource)}` : def.name,
      available: () => def.available() && (def.availableOn ? def.availableOn(currentSource) : true),
      // Distinguish "this device cannot" from "this channel cannot". On a
      // recorder a sibling channel may well support what this one does not, and
      // telling the operator that is the difference between a dead end and a
      // next step.
      reason: () => {
        if (!def.available()) {
          return typeof def.reason === 'function' ? def.reason(currentSource) : def.reason;
        }
        const label = channelLabel(currentSource);
        return def.reasonOnChannel
          ? def.reasonOnChannel(label)
          : `${label} does not report support for this. Other channels on this device may still support it.`;
      },
    }));

  // --- Persistent controls: right sidebar on wide screens, draggable sheet on mobile ---
  const sidebarState = readSidebarState();
  const sidebar = el('aside', 'controller-sidebar');
  sidebar.setAttribute('aria-label', 'Camera controls');
  sidebar.id = 'controller-sidebar';
  const sidebarHeader = el('div', 'sidebar-header');
  const sheetGrip = el('div', 'sidebar-sheet-grip');
  sheetGrip.setAttribute('aria-hidden', 'true');
  const sidebarTitle = el('h1', 'sidebar-title', 'Camera controls');
  const sidebarToggle = el('button', 'btn btn-ghost btn-sm sidebar-collapse');
  sidebarToggle.type = 'button';
  sidebarToggle.setAttribute('aria-label', 'Collapse camera controls');
  sidebarToggle.setAttribute('aria-controls', 'controller-sidebar');
  sidebarToggle.setAttribute('aria-expanded', String(!sidebarState.collapsed));
  const videoSidebarToggle = el('button', 'btn btn-ghost btn-sm video-sidebar-toggle', 'Show controls');
  videoSidebarToggle.type = 'button';
  videoSidebarToggle.setAttribute('aria-label', 'Expand camera controls');
  videoSidebarToggle.setAttribute('aria-controls', 'controller-sidebar');
  videoSidebarToggle.setAttribute('aria-expanded', String(!sidebarState.collapsed));
  videoSidebarToggle.hidden = true;
  stage.appendChild(videoSidebarToggle);
  sidebarHeader.append(sheetGrip, sidebarTitle, sidebarToggle);

  const sidebarScroll = el('div', 'sidebar-scroll');
  const sidebarSectionsHost = el('div', 'sidebar-sections');
  sidebarScroll.appendChild(sidebarSectionsHost);

  // Device-wide sections sit behind a labelled divider so nobody mistakes
  // 'Network' for a channel setting and re-IPs the whole recorder.
  let deviceSectionsHost = null;
  if (isMultiChannel) {
    const scopeDivider = el('div', 'sidebar-scope');
    scopeDivider.append(
      el('p', 'sidebar-scope-title', 'Whole recorder'),
      el('p', 'sidebar-scope-note', 'The sections below apply to the device itself — every channel at once — not to the selected channel.'),
    );
    deviceSectionsHost = el('div', 'sidebar-sections');
    sidebarScroll.append(scopeDivider, deviceSectionsHost);
  }
  const sidebarFooter = el('div', 'sidebar-footer');
  const disconnectBtn = el('button', 'btn btn-danger sidebar-disconnect', 'Disconnect');
  disconnectBtn.type = 'button';
  cleanups.push(pressable(disconnectBtn));
  const disconnect = () => {
    if (destroyed) return;
    api.disconnect(session.sessionId).catch(() => {});
    teardownToConnect();
  };
  disconnectBtn.addEventListener('click', disconnect);
  cleanups.push(() => disconnectBtn.removeEventListener('click', disconnect));
  sidebarFooter.appendChild(disconnectBtn);
  sidebar.append(sidebarHeader, sidebarScroll, sidebarFooter);
  shell.appendChild(sidebar);

  // channelSections holds the per-source sections on a recorder — or every
  // section on a single-source device, which is today's exact layout. It is
  // torn down and rebuilt on channel change so no panel can keep showing
  // another channel's values; its per-build listener cleanups run with it.
  let channelCleanups = [];
  let channelSections = null;
  let deviceSections = null;

  function buildChannelSections() {
    if (channelSections) channelSections.destroy();
    for (const fn of channelCleanups) fn();
    channelCleanups = [];
    sidebarSectionsHost.replaceChildren();
    channelSections = isMultiChannel
      ? new SidebarSections(sidebarSectionsHost, scopedPanelDefs('source'), sidebarState, channelCleanups)
      : new SidebarSections(sidebarSectionsHost, PANEL_DEFS, sidebarState, channelCleanups);
  }

  // Switching channels retargets everything per-source: the profile switcher,
  // the scoped sections, and the live stream — which is stopped and restarted
  // on the new channel's matching profile (main stays main, sub stays sub).
  function selectChannel(index) {
    if (destroyed || !isMultiChannel) return;
    const next = sources[index];
    if (!next || next === currentSource) return;
    const previousName = (currentProfiles().find((p) => p.token === currentProfile) || {}).name;
    currentSource = next;
    const profiles = currentProfiles();
    const matching = previousName ? profiles.find((p) => p.name === previousName) : null;
    currentProfile = (matching || profiles[0] || {}).token || null;
    paintChannelStrip(index);
    buildProfileSwitcher();
    buildChannelSections();
    stats.hidden = true;
    player.stop();
    if (currentProfile) {
      connLabel.textContent = 'Connecting';
      connDot.dataset.tone = 'warn';
      player.start(currentProfile).catch((err) => showError(err instanceof ApiError ? err : new ApiError('STREAM_FAILED', String(err))));
    } else {
      connLabel.textContent = 'No profiles';
      connDot.dataset.tone = 'bad';
    }
  }

  buildChannelSections();
  if (isMultiChannel && deviceSectionsHost) {
    deviceSections = new SidebarSections(deviceSectionsHost, scopedPanelDefs('device'), sidebarState, cleanups);
  }
  let sidebarSpring = null;
  let sidebarValue = sidebarState.collapsed ? 1 : 0;
  let dragStartValue = sidebarValue;
  const mobileQuery = window.matchMedia('(max-width: 56.25rem)');

  function closedDistance() {
    return mobileQuery.matches
      ? Math.max(0, sidebar.offsetHeight - sidebarHeader.offsetHeight)
      : sidebar.offsetWidth;
  }

  function paintSidebar(value) {
    sidebarValue = value;
    const distance = closedDistance();
    sidebar.style.transform = mobileQuery.matches
      ? `translateY(${distance * value}px)`
      : `translateX(${distance * value}px)`;
    shell.classList.toggle('sidebar-collapsed', value >= 0.999);
  }

  function setSidebarCollapsed(collapsed, velocity = 0) {
    sidebarState.collapsed = collapsed;
    writeSidebarState(sidebarState);
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand camera controls' : 'Collapse camera controls');
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.textContent = collapsed ? (mobileQuery.matches ? 'Up' : 'Open') : (mobileQuery.matches ? 'Down' : 'Hide');
    videoSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    videoSidebarToggle.hidden = !collapsed || mobileQuery.matches;
    if (sidebarSpring) sidebarSpring.stop();
    if (prefersReducedMotion()) {
      paintSidebar(collapsed ? 1 : 0);
      sidebar.style.opacity = collapsed ? '0.92' : '1';
      return;
    }
    sidebar.style.opacity = '1';
    sidebarSpring = spring({
      from: sidebarValue,
      to: collapsed ? 1 : 0,
      velocity: velocity / Math.max(closedDistance(), 1),
      damping: Math.abs(velocity) > 40 ? 0.8 : 1.0,
      response: 0.35,
      onUpdate: paintSidebar,
      onComplete: () => { sidebarSpring = null; },
    });
  }

  cleanups.push(pressable(sidebarToggle));
  const toggleSidebar = () => setSidebarCollapsed(!sidebarState.collapsed);
  sidebarToggle.addEventListener('click', toggleSidebar);
  cleanups.push(() => sidebarToggle.removeEventListener('click', toggleSidebar));
  cleanups.push(pressable(videoSidebarToggle));
  videoSidebarToggle.addEventListener('click', toggleSidebar);
  cleanups.push(() => videoSidebarToggle.removeEventListener('click', toggleSidebar));

  const dragCleanup = draggable(sidebarHeader, {
    axis: mobileQuery.matches ? 'y' : 'x',
    hysteresis: 8,
    onStart: () => {
      sidebarSpring?.stop();
      sidebarSpring = null;
      dragStartValue = sidebarValue;
    },
    onMove: ({ dx, dy }) => {
      const distance = Math.max(closedDistance(), 1);
      const delta = mobileQuery.matches ? dy : dx;
      const raw = dragStartValue + delta / distance;
      const value = raw < 0
        ? rubberband(raw * distance, distance) / distance
        : raw > 1
          ? 1 + rubberband((raw - 1) * distance, distance) / distance
          : raw;
      paintSidebar(value);
    },
    onEnd: ({ committed, velocity }) => {
      if (!committed) return;
      const axisVelocity = mobileQuery.matches ? velocity.y : velocity.x;
      const projected = sidebarValue + project(axisVelocity) / Math.max(closedDistance(), 1);
      setSidebarCollapsed(projected >= 0.5, axisVelocity);
    },
    onCancel: () => setSidebarCollapsed(sidebarState.collapsed),
  });
  cleanups.push(dragCleanup);

  const onBreakpointChange = () => {
    sidebar.style.transform = '';
    sidebarValue = sidebarState.collapsed ? 1 : 0;
    paintSidebar(sidebarValue);
    setSidebarCollapsed(sidebarState.collapsed);
  };
  mobileQuery.addEventListener('change', onBreakpointChange);
  cleanups.push(() => mobileQuery.removeEventListener('change', onBreakpointChange));
  requestAnimationFrame(() => setSidebarCollapsed(sidebarState.collapsed));

  root.appendChild(shell);

  // --- Player ---
  const player = createPlayer({ video, sessionId: session.sessionId });

  const offState = player.on('state', (state) => {
    if (destroyed) return;
    const [label, tone] = PLAYER_STATE_LABEL[state] || [state, 'warn'];
    connLabel.textContent = label;
    connDot.dataset.tone = tone;
    stage.dataset.playerState = state;

    if (state === 'playing') {
      hideStageMessage();
    } else if (state === 'connecting') {
      showStageMessage('Starting the live view…',
        'Negotiating RTSP with the camera and starting the encoder.', { retry: false });
    } else if (state === 'reconnecting') {
      showStageMessage('Live view interrupted',
        'Lost contact with the stream. Reconnecting automatically — the camera itself may still be fine.',
        { retry: false });
    } else if (state === 'degraded') {
      showStageMessage('Showing snapshots instead of live video',
        'The live stream could not be sustained, so this is refreshing still images about twice a second.');
    } else if (state === 'error') {
      showStageMessage('Live view unavailable',
        'The stream could not be started. Check that the camera is reachable over RTSP on port 554 and that this ONVIF user is allowed to view the channel.');
    }
  });
  const offStats = player.on('stats', (s) => {
    if (destroyed || !s) return;
    const p = session.profiles.find((x) => x.token === currentProfile);
    const parts = [];
    if (p && p.video) {
      parts.push(`${p.video.width}×${p.video.height}`, p.video.codec);
    }
    if (typeof s.fps === 'number') parts.push(`${s.fps.toFixed(1)} fps`);
    if (typeof s.bitrateKbps === 'number') parts.push(`${Math.round(s.bitrateKbps)} kbps`);
    if (typeof s.latencyMs === 'number') parts.push(`${Math.round(s.latencyMs)} ms`);
    stats.textContent = parts.join(' · ');
    stats.hidden = parts.length === 0;
  });
  const retryStream = () => {
    if (destroyed || !currentProfile) return;
    hideStageMessage();
    player.stop();
    player.start(currentProfile).catch((err) => {
      showError(err instanceof ApiError ? err : new ApiError('STREAM_FAILED', String(err)));
      showStageMessage('Live view unavailable', err?.hint || err?.message || 'The stream could not be started.');
    });
  };
  stageRetry.addEventListener('click', retryStream);
  cleanups.push(() => stageRetry.removeEventListener('click', retryStream));

  const offDegraded = player.on('degraded', ({ reason } = {}) => {
    if (destroyed) return;
    connLabel.textContent = 'Degraded — snapshots';
    connDot.dataset.tone = 'warn';
    if (reason) showError(new ApiError('STREAM_FAILED', `Stream degraded: ${reason}`, 'Showing snapshots at 2fps until the stream recovers.'));
  });
  const offError = player.on('error', ({ code, message } = {}) => {
    if (destroyed) return;
    showError(new ApiError(code || 'STREAM_FAILED', message || 'The stream failed.'));
  });
  cleanups.push(offState, offStats, offDegraded, offError);

  function selectProfile(token) {
    currentProfile = token;
    if (profileSegmented) {
      for (const btn of profileSegmented.children) {
        btn.classList.toggle('segment-active', btn.dataset.token === token);
      }
    }
    stats.hidden = true;
    connLabel.textContent = 'Connecting';
    connDot.dataset.tone = 'warn';
    // PTZ/imaging views are per-profile: rebuild them against the new token.
    // On a recorder this rebuilds the channel-scoped sections only; on a
    // single-source device channelSections holds every section, as before.
    channelSections.rebuildViews();
    player.stop();
    player.start(token).catch((err) => showError(err instanceof ApiError ? err : new ApiError('STREAM_FAILED', String(err))));
  }

  if (currentProfile) {
    player.start(currentProfile).catch((err) => showError(err instanceof ApiError ? err : new ApiError('STREAM_FAILED', String(err))));
  } else {
    connLabel.textContent = 'No profiles';
    connDot.dataset.tone = 'bad';
  }

  // --- Session liveness: rehydrate check catches server-side expiry ---
  const livenessTimer = setInterval(() => {
    if (destroyed) return;
    api.getSession(session.sessionId).catch((err) => {
      if (!destroyed && err instanceof ApiError && err.code === 'SESSION_EXPIRED') {
        teardownToConnect(err);
      }
    });
  }, 60_000);
  cleanups.push(() => clearInterval(livenessTimer));

  let tornDown = false;
  function teardownToConnect(reason) {
    if (tornDown || destroyed) return;
    tornDown = true;
    onDisconnect(reason || null);
  }

  return () => {
    destroyed = true;
    channelSections?.destroy();
    deviceSections?.destroy();
    for (const fn of channelCleanups) fn();
    sidebarSpring?.stop();
    player.destroy();
    if (toastTimer) clearTimeout(toastTimer);
    if (toastSpring) toastSpring.stop();
    cleanups.forEach((fn) => fn());
    if (!tornDown) {
      // Unmounted without an explicit disconnect (shouldn't happen via the
      // router, but never leak a server session).
      api.disconnect(session.sessionId).catch(() => {});
    }
  };
}
