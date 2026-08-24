// views/controller.js — the main shell.
//
// The video is the hero surface; control panels are translucent
// backdrop-filter layers over and around it. Panels render ONLY for services
// the capability matrix reports as supported — an unsupported panel is
// absent, never disabled. Panel enter/exit runs on springs along the same
// path, with transform-origin anchored to the dock control that opened it.
// Nothing here is optimistic: every state shown comes from the player, the
// WebSocket, or a completed API call.

import { createPlayer } from '../player.js';
import { api, ApiError } from '../api.js';
import { spring, project, rubberband, prefersReducedMotion } from '../spring.js';
import { draggable, pressable } from '../gesture.js';
import { renderJoystick } from './joystick.js';
import { renderPresets } from './presets.js';
import { renderImaging } from './imaging.js';
import { renderEvents } from './events.js';

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

// ---------------------------------------------------------------------------
// Panel manager — one translucent panel at a time, spring enter/exit along
// the same path, transform-origin anchored to the opener, drag-to-dismiss
// with rubber-band resistance and momentum projection.
// ---------------------------------------------------------------------------
class PanelManager {
  constructor(host, { onError, onOpenChange }) {
    this.host = host;
    this.onError = onError;
    this.onOpenChange = onOpenChange || (() => {});
    this.openName = null;
    this.panel = null;       // { name, root, view, motion, dragCleanup }
    this.views = new Map();  // name -> { view, builtForProfile }
  }

  isOpen(name) {
    return this.openName === name;
  }

  /** Drop built views so a profile switch rebuilds them against the new token. */
  invalidateViews() {
    for (const { view } of this.views.values()) {
      if (view && view.destroy) view.destroy();
    }
    this.views.clear();
    if (this.panel) this.close(true);
  }

  toggle(name, anchorBtn, buildView) {
    if (this.isOpen(name)) {
      this.close();
    } else {
      this.open(name, anchorBtn, buildView);
    }
  }

  open(name, anchorBtn, buildView) {
    if (this.panel) this.close(true);

    const root = el('div', 'panel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.setAttribute('aria-label', name);
    const header = el('div', 'panel-header');
    const grip = el('div', 'panel-grip');
    const title = el('h2', 'panel-title', name);
    const closeBtn = el('button', 'btn btn-ghost btn-sm panel-close', 'Close');
    closeBtn.type = 'button';
    pressable(closeBtn);
    closeBtn.addEventListener('click', () => this.close());
    header.append(grip, title, closeBtn);
    const content = el('div', 'panel-content');
    root.append(header, content);
    this.host.appendChild(root);

    // Build (or reuse) the view for this panel.
    let entry = this.views.get(name);
    if (!entry) {
      const view = buildView(content);
      entry = { view };
      this.views.set(name, entry);
    } else {
      content.appendChild(entry.view.el);
    }

    this.panel = { name, root, closeBtn, anchorBtn, drag: { ty: 0, spring: null } };
    this.openName = name;
    if (anchorBtn) {
      anchorBtn.setAttribute('aria-haspopup', 'dialog');
      anchorBtn.setAttribute('aria-expanded', 'true');
    }
    this.onOpenChange(name);

    // Escape dismisses the panel from anywhere; it never traps focus.
    const onKeydown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.close();
    };
    document.addEventListener('keydown', onKeydown);
    this.panel.escapeCleanup = () => document.removeEventListener('keydown', onKeydown);

    // Focus moves into the panel when it opens...
    closeBtn.focus({ preventScroll: true });

    // Anchor the transform-origin to the control that opened the panel, so
    // enter and exit run along the same spatial path.
    requestAnimationFrame(() => {
      if (this.panel?.root !== root) return;
      const p = root.getBoundingClientRect();
      const b = anchorBtn.getBoundingClientRect();
      const ox = Math.min(Math.max(b.left + b.width / 2 - p.left, 0), p.width);
      root.style.transformOrigin = `${ox}px ${p.height}px`;
    });

    this.animateOpen(root);
    this.attachDrag(header, root);
  }

  animateOpen(root) {
    if (prefersReducedMotion()) {
      root.style.opacity = '0';
      const s = spring({
        from: 0, to: 1, response: 0.2,
        onUpdate: (v) => { root.style.opacity = String(v); },
      });
      this.panel.openSpring = s;
      return;
    }
    const s = spring({
      from: 0, to: 1, damping: 1.0, response: 0.35,
      onUpdate: (v) => {
        const inv = 1 - v;
        root.style.opacity = String(v);
        root.style.transform = `translateY(${24 * inv}px) scale(${0.94 + 0.06 * v})`;
      },
    });
    this.panel.openSpring = s;
  }

  attachDrag(handleEl, root) {
    const panel = this.panel;
    panel.dragCleanup = draggable(handleEl, {
      axis: 'y',
      hysteresis: 8,
      onStart: () => {
        if (panel.openSpring) { panel.openSpring.stop(); panel.openSpring = null; }
        if (panel.drag.spring) { panel.drag.spring.stop(); panel.drag.spring = null; }
        panel.drag.ty = 0;
      },
      onMove: ({ dy }) => {
        // Downward drag tracks 1:1; upward rubber-bands at the top bound.
        panel.drag.ty = dy > 0 ? dy : rubberband(dy, root.offsetHeight || 1);
        root.style.transform = `translateY(${panel.drag.ty}px) scale(1)`;
        root.style.opacity = String(1 - Math.max(0, Math.min(panel.drag.ty / (root.offsetHeight || 1), 0.6)));
      },
      onEnd: ({ velocity, committed }) => {
        if (!committed) return;
        const height = root.offsetHeight || 1;
        const projected = panel.drag.ty + project(velocity.y);
        if (projected > height * 0.4) {
          // Momentum carries it away — dismiss along the same path.
          this.dismissWithVelocity(velocity.y);
        } else if (prefersReducedMotion()) {
          panel.drag.ty = 0;
          root.style.transform = '';
          root.style.opacity = '1';
        } else {
          panel.drag.spring = spring({
            from: panel.drag.ty, to: 0, velocity: velocity.y,
            damping: 1.0, response: 0.3,
            onUpdate: (v) => {
              panel.drag.ty = v;
              root.style.transform = `translateY(${v}px) scale(1)`;
              root.style.opacity = String(1 - Math.min(Math.abs(v) / height, 0.6));
            },
            onComplete: () => {
              root.style.transform = '';
              root.style.opacity = '1';
              panel.drag.spring = null;
            },
          });
        }
      },
    });
  }

  dismissWithVelocity(vy) {
    const panel = this.panel;
    if (!panel) return;
    const { root } = panel;
    const height = root.offsetHeight || 1;
    const finish = () => this.close(true);
    if (prefersReducedMotion()) {
      const s = spring({
        from: 1, to: 0, response: 0.2,
        onUpdate: (v) => { root.style.opacity = String(v); },
        onComplete: finish,
      });
      panel.openSpring = s;
      return;
    }
    panel.openSpring = spring({
      from: panel.drag.ty, to: height + 40, velocity: vy,
      damping: 1.0, response: 0.3,
      onUpdate: (v) => {
        root.style.transform = `translateY(${v}px) scale(${1 - Math.min(v / height, 1) * 0.06})`;
        root.style.opacity = String(1 - Math.min(v / height, 1));
      },
      onComplete: finish,
    });
    this.openName = null; // already semantically closed; animation runs out
  }

  /** Close the open panel. immediate=true skips the exit spring (teardown). */
  close(immediate = false) {
    const panel = this.panel;
    if (!panel) return;
    this.panel = null;
    this.openName = null;
    if (panel.dragCleanup) panel.dragCleanup();
    if (panel.escapeCleanup) panel.escapeCleanup();
    if (panel.drag.spring) panel.drag.spring.stop();
    if (panel.openSpring) panel.openSpring.stop();

    // Return focus to the control that opened the panel. Without this a
    // keyboard user is dumped back at the top of the document every time they
    // dismiss one, and Escape becomes a trap of a different kind.
    if (panel.anchorBtn && panel.anchorBtn.isConnected && document.activeElement !== panel.anchorBtn) {
      const active = document.activeElement;
      const focusWasInPanel = !active || active === document.body || panel.root.contains(active);
      if (focusWasInPanel) panel.anchorBtn.focus({ preventScroll: true });
    }
    if (panel.anchorBtn) panel.anchorBtn.setAttribute('aria-expanded', 'false');

    const { root, name } = panel;
    const entry = this.views.get(name);
    const detach = () => {
      if (entry && entry.view.el.parentNode === root.querySelector('.panel-content')) {
        entry.view.el.remove();
      }
      root.remove();
    };

    if (immediate || prefersReducedMotion() && !root.isConnected) {
      detach();
      return;
    }
    if (prefersReducedMotion()) {
      const s = spring({
        from: 1, to: 0, response: 0.2,
        onUpdate: (v) => { root.style.opacity = String(v); },
        onComplete: () => { s.stop(); detach(); },
      });
      return;
    }
    // Exit along the same path it entered: down and slightly smaller, out
    // through the anchored transform-origin.
    const s = spring({
      from: 1, to: 0, damping: 1.0, response: 0.3,
      onUpdate: (v) => {
        const inv = 1 - v;
        root.style.opacity = String(v);
        root.style.transform = `translateY(${24 * inv}px) scale(${0.94 + 0.06 * v})`;
      },
      onComplete: () => { s.stop(); detach(); },
    });
  }

  destroy() {
    this.close(true);
    this.invalidateViews();
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
  let currentProfile = session.profiles && session.profiles[0] ? session.profiles[0].token : null;

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
  if (session.profiles && session.profiles.length > 1) {
    profileSegmented = el('div', 'segmented profile-switcher');
    profileSegmented.setAttribute('role', 'group');
    profileSegmented.setAttribute('aria-label', 'Stream profile');
    for (const p of session.profiles) {
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

  // --- Panels ---
  const panelHost = el('div', 'panel-host');
  shell.appendChild(panelHost);
  const panels = new PanelManager(panelHost, { onError: showError });

  // --- Dock ---
  const dock = el('div', 'dock');

  const ctx = () => ({
    sessionId: session.sessionId,
    profile: currentProfile,
    ptz: session.ptz,
    session,
    onError: showError,
  });

  const PANEL_DEFS = [
    {
      name: 'PTZ',
      available: () => Boolean(session.capabilities && session.capabilities.ptz && session.ptz),
      build: (c) => renderJoystick(c, { ...ctx() }),
    },
    {
      name: 'Presets',
      available: () => Boolean(session.capabilities && session.capabilities.ptz && session.ptz && session.ptz.presetsSupported),
      build: (c) => renderPresets(c, { ...ctx() }),
    },
    {
      name: 'Imaging',
      available: () => Boolean(session.capabilities && session.capabilities.imaging),
      build: (c) => renderImaging(c, { ...ctx() }),
    },
    {
      name: 'Events',
      available: () => Boolean(session.capabilities && session.capabilities.events),
      build: (c) => renderEvents(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Device',
      available: () => true,
      build: (c) => renderDevice(c, { sessionId: session.sessionId, onError: showError }),
    },
    {
      name: 'Capabilities',
      available: () => true,
      build: (c) => renderCapabilities(c, { session }),
    },
  ];

  for (const def of PANEL_DEFS) {
    if (!def.available()) continue; // absent, never disabled
    const btn = el('button', 'btn dock-btn', def.name);
    btn.type = 'button';
    cleanups.push(pressable(btn));
    const toggle = () => {
      panels.toggle(def.name, btn, def.build);
      btn.classList.toggle('dock-btn-active', panels.isOpen(def.name));
    };
    btn.addEventListener('click', toggle);
    cleanups.push(() => btn.removeEventListener('click', toggle));
    dock.appendChild(btn);
  }

  const disconnectBtn = el('button', 'btn btn-ghost dock-btn dock-disconnect', 'Disconnect');
  disconnectBtn.type = 'button';
  cleanups.push(pressable(disconnectBtn));
  const disconnect = () => {
    if (destroyed) return;
    api.disconnect(session.sessionId).catch(() => {});
    teardownToConnect();
  };
  disconnectBtn.addEventListener('click', disconnect);
  cleanups.push(() => disconnectBtn.removeEventListener('click', disconnect));
  dock.appendChild(disconnectBtn);

  shell.appendChild(dock);
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
    panels.invalidateViews();
    for (const btn of dock.children) btn.classList.remove('dock-btn-active');
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
    panels.destroy();
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
