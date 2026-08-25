// views/fanout.js — read-only webhook delivery status.
//
// Renders GET /api/fanout: the configured targets and their live delivery
// counters. Read-only by design (UI-AVAILABILITY.md): targets carry HMAC
// secrets and this app has no authentication, so the browser never creates,
// edits, or deletes one — configuration stays in the FANOUT_CONFIG file.
//
// SECURITY: the API returns only `hasSecret`, never a secret value, and this
// view never reads, stores, logs, or renders anything else. Target URLs are
// rendered as plain text — never as links — so a click cannot leak the URL
// (which may embed credentials) through a referrer header.
//
// A tripped circuit breaker is the single most important thing on this panel;
// it renders as a prominent block naming when delivery resumes and why it
// stopped. Stats refresh on a slow interval — these are counters, not a live
// feed — and the timer stops with the panel.

import { ApiError } from '../api.js';

const REFRESH_INTERVAL_MS = 4_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Same wire contract as api.js: parse the { error: { code, message, hint } }
// envelope on non-2xx and throw an ApiError. api.js itself carries no fan-out
// methods; these two endpoints need no session id.
async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      'DEVICE_UNREACHABLE',
      'The controller server did not answer.',
      'Check that the server process is running on this machine.',
      0,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw new ApiError(
      err.code || 'INTERNAL',
      err.message || `Request failed with status ${res.status}.`,
      err.hint !== undefined ? err.hint : null,
      res.status,
    );
  }
  return data;
}

function formatTime(isoTime) {
  if (!isoTime) return '';
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return String(isoTime);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

const STAT_FIELDS = [
  ['delivered', 'Delivered'],
  ['failed', 'Failed'],
  ['dropped', 'Dropped'],
  ['queue', 'Queue'],
  ['retries', 'Retries'],
  ['trips', 'Breaker trips'],
  ['lastDelivery', 'Last delivery'],
];

/**
 * @param {HTMLElement} container
 * @param {{ onError: (err: object) => void }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function renderFanout(container, { onError }) {
  let destroyed = false;
  let timer = null;
  // A failed poll is reported to onError once per outage, not once per
  // interval — a toast re-firing every few seconds is its own failure mode.
  let pollFailed = false;
  const cards = new Map(); // target id -> card, so test results survive refreshes

  const wrap = el('div', 'fanout');
  const status = el('p', 'panel-status', 'Reading fan-out status…');
  const configErrors = el('div', 'fanout-config-errors');
  const list = el('div', 'fanout-targets');
  wrap.append(status, configErrors, list);
  container.appendChild(wrap);

  function report(err) {
    if (!destroyed && typeof onError === 'function') onError(err);
  }

  function buildCard(target) {
    const root = el('article', 'fanout-target');

    const head = el('div', 'fanout-target-head');
    // Plain text, never an <a>: the URL is operator-supplied and may embed
    // credentials; a link would leak it via the referrer on click.
    const url = el('span', 'fanout-url', target.url);
    const enabledBadge = el('span', 'fanout-badge');
    // Only `hasSecret` is ever consulted. There is no code path here that can
    // display a secret, because the API never sends one.
    const secretBadge = el('span', 'fanout-badge');
    head.append(url, enabledBadge, secretBadge);

    const filters = el('p', 'fanout-filters');

    const breaker = el('div', 'fanout-breaker');
    breaker.hidden = true;

    const statsGrid = el('div', 'fanout-stats');
    const fields = {};
    for (const [key, label] of STAT_FIELDS) {
      const row = el('div', 'kv-row');
      const value = el('span', 'kv-value', '—');
      row.append(el('span', 'kv-key', label), value);
      statsGrid.appendChild(row);
      fields[key] = value;
    }

    const note = el('p', 'fanout-note');

    const actions = el('div', 'fanout-actions');
    const testBtn = el('button', 'btn btn-ghost btn-sm', 'Send test event');
    testBtn.type = 'button';
    const result = el('div', 'fanout-test-result');
    result.setAttribute('aria-live', 'polite');
    actions.append(testBtn, result);

    root.append(head, filters, breaker, statsGrid, note, actions);

    const sendTest = async () => {
      if (destroyed || testBtn.disabled) return;
      testBtn.disabled = true;
      result.dataset.state = '';
      result.replaceChildren(el('p', 'fanout-test-line', 'Sending test event…'));
      try {
        const res = await request('POST', '/api/fanout/test', { id: target.id });
        if (destroyed) return;
        // The receiver's real answer, left on screen: HTTP status, status
        // text, and round-trip time. `response` is arbitrary receiver text —
        // textContent only, never innerHTML.
        const statusLine = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} — ${res.elapsedMs} ms`;
        const lines = [
          el('p', 'fanout-test-line',
            res.ok ? `Accepted by the receiver: ${statusLine}` : `Rejected by the receiver: ${statusLine}`),
        ];
        if (res.response) {
          lines.push(el('p', 'fanout-test-body',
            `Receiver replied: ${res.response}${res.responseTruncated ? '… (truncated)' : ''}`));
        }
        result.dataset.state = res.ok ? 'ok' : 'bad';
        result.replaceChildren(...lines);
      } catch (err) {
        if (destroyed) return;
        // The real connection error text — this button exists for debugging,
        // so the failure is the information. Shown inline, not flashed away.
        const lines = [el('p', 'fanout-test-line', err?.message || 'The test event could not be sent.')];
        if (err?.hint) lines.push(el('p', 'fanout-test-body', err.hint));
        result.dataset.state = 'bad';
        result.replaceChildren(...lines);
      } finally {
        if (!destroyed) testBtn.disabled = false;
      }
    };
    testBtn.addEventListener('click', sendTest);

    return {
      root, enabledBadge, secretBadge, filters, breaker, statsGrid, fields, note,
      destroy() {
        testBtn.removeEventListener('click', sendTest);
      },
    };
  }

  function updateCard(card, target) {
    const stats = target.stats ?? null;

    card.enabledBadge.textContent = target.enabled === false ? 'Disabled' : 'Enabled';
    card.enabledBadge.dataset.tone = target.enabled === false ? 'warn' : 'ok';
    card.secretBadge.textContent = target.hasSecret ? 'signed' : 'unsigned';
    card.secretBadge.dataset.tone = target.hasSecret ? 'ok' : 'warn';

    card.filters.textContent = Array.isArray(target.filters) && target.filters.length > 0
      ? `Filters: ${target.filters.join(', ')}`
      : 'Filters: all events';

    let state = target.enabled === false ? 'disabled' : 'ok';

    if (!stats) {
      // No live session has a dispatcher for this target, so there are no
      // counters yet — say that instead of showing zeroes that look real.
      card.statsGrid.hidden = true;
      card.breaker.hidden = true;
      card.note.hidden = false;
      card.note.textContent = 'No delivery counters yet — they appear while a session is connected and events flow.';
    } else {
      card.statsGrid.hidden = false;
      const droppedQueueFull = stats.droppedQueueFull ?? 0;
      const droppedBreakerOpen = stats.droppedBreakerOpen ?? 0;
      card.fields.delivered.textContent = String(stats.delivered ?? 0);
      card.fields.failed.textContent = String(stats.failed ?? 0);
      card.fields.dropped.textContent = droppedQueueFull + droppedBreakerOpen > 0
        ? `${droppedQueueFull + droppedBreakerOpen} (queue full ${droppedQueueFull} · breaker open ${droppedBreakerOpen})`
        : '0';
      card.fields.queue.textContent = `${stats.queued ?? 0} queued · ${stats.inFlight ?? 0} in flight`;
      card.fields.retries.textContent = String(stats.retries ?? 0);
      card.fields.trips.textContent = String(stats.breakerTrips ?? 0);
      card.fields.lastDelivery.textContent = formatTime(stats.lastDeliveryAt) || '—';
      card.note.hidden = true;

      if (stats.breakerOpen) {
        // The thing the operator most needs to see: delivery is paused, when
        // it resumes, and why it stopped.
        state = 'bad';
        const untilMs = Date.parse(stats.breakerOpenUntil);
        const secondsLeft = Number.isNaN(untilMs) ? null : Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
        const reopen = Number.isNaN(untilMs)
          ? 'Reopen time unknown.'
          : `Reopens at ${formatTime(stats.breakerOpenUntil)}${secondsLeft !== null ? ` (in ${secondsLeft}s)` : ''}.`;
        const lines = [el('p', 'fanout-breaker-title', 'Circuit breaker open — deliveries to this target are paused.')];
        lines.push(el('p', 'fanout-breaker-detail', reopen));
        if (stats.lastError) lines.push(el('p', 'fanout-breaker-detail', `Last error: ${stats.lastError}`));
        card.breaker.replaceChildren(...lines);
        card.breaker.hidden = false;
      } else {
        card.breaker.hidden = true;
        if (state === 'ok' && droppedQueueFull + droppedBreakerOpen > 0) state = 'warn';
      }
    }

    card.root.dataset.state = state;
  }

  function render(data) {
    status.hidden = true;

    // Config load problems (unreadable file, rejected URLs) are operator-
    // actionable and come from the server as plain reason strings.
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    configErrors.replaceChildren(...errors
      .map((entry) => entry?.reason)
      .filter(Boolean)
      .map((reason) => el('p', 'fanout-config-error', reason)));

    const targets = Array.isArray(data?.targets) ? data.targets : [];
    if (targets.length === 0) {
      for (const card of cards.values()) card.destroy();
      cards.clear();
      list.replaceChildren(el('p', 'panel-status',
        'No webhook targets are configured. Set FANOUT_CONFIG to a JSON file of targets and restart.'));
      return;
    }

    const seen = new Set();
    for (const target of targets) {
      if (!target || typeof target.id !== 'string') continue;
      seen.add(target.id);
      let card = cards.get(target.id);
      if (!card) {
        card = buildCard(target);
        cards.set(target.id, card);
      }
      updateCard(card, target);
    }
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.destroy();
        cards.delete(id);
      }
    }
    // Re-append in server order; existing nodes move, keeping their listeners
    // and any on-screen test result.
    list.replaceChildren(...targets
      .filter((target) => target && typeof target.id === 'string')
      .map((target) => cards.get(target.id).root));
  }

  async function refresh() {
    if (destroyed) return;
    try {
      const data = await request('GET', '/api/fanout');
      if (destroyed) return;
      pollFailed = false;
      render(data ?? {});
    } catch (err) {
      if (destroyed) return;
      if (!pollFailed) {
        pollFailed = true;
        report(err);
      }
      // If nothing has rendered yet, say so rather than leaving an empty
      // panel; once content exists, keep it — stale counters beat a blank.
      if (cards.size === 0 && list.childElementCount === 0) {
        status.hidden = false;
        status.textContent = 'Fan-out status could not be read. Retrying…';
      }
    }
  }

  refresh();
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      if (timer) { clearInterval(timer); timer = null; }
      for (const card of cards.values()) card.destroy();
      cards.clear();
    },
  };
}
