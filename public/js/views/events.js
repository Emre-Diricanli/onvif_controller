// views/events.js — live ONVIF event feed over /ws/events.
//
// Newest first, timestamped, with a topic filter built from the topics
// actually seen. Client pings every 25s per the contract; abnormal socket
// closure reconnects with backoff, and the connection state is always shown
// truthfully.

import { wsUrl } from '../api.js';

const PING_INTERVAL_MS = 25_000;
const MAX_EVENTS = 200;
const MAX_RECONNECT_DELAY_MS = 10_000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(utcTime) {
  const d = utcTime ? new Date(utcTime) : new Date();
  if (Number.isNaN(d.getTime())) return utcTime || '';
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatData(data) {
  if (!data || typeof data !== 'object') return '';
  return Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join('  ·  ');
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, onError: (err: object) => void }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function renderEvents(container, { sessionId, onError }) {
  let destroyed = false;
  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  const knownTopics = new Set();
  let activeFilter = 'all';
  const entries = []; // { topic, row } for filtering without re-rendering

  const wrap = el('div', 'events');

  const toolbar = el('div', 'events-toolbar');
  const stateDot = el('span', 'conn-dot');
  const stateLabel = el('span', 'conn-label', 'Connecting');
  const state = el('span', 'events-state');
  state.append(stateDot, stateLabel);
  const filter = el('select', 'topic-filter');
  filter.setAttribute('aria-label', 'Filter by topic');
  const allOption = el('option', '', 'All topics');
  allOption.value = 'all';
  filter.appendChild(allOption);
  toolbar.append(state, filter);

  const list = el('ul', 'event-list');
  const empty = el('p', 'panel-status', 'Waiting for events…');
  wrap.append(toolbar, empty, list);
  container.appendChild(wrap);

  function setState(label, tone) {
    stateLabel.textContent = label;
    stateDot.dataset.tone = tone; // 'ok' | 'warn' | 'bad'
  }

  function applyFilter() {
    let visible = 0;
    for (const entry of entries) {
      const show = activeFilter === 'all' || entry.topic === activeFilter;
      entry.row.hidden = !show;
      if (show) visible += 1;
    }
    if (entries.length === 0) {
      empty.hidden = false;
      empty.textContent = 'Waiting for events…';
    } else if (visible === 0) {
      empty.hidden = false;
      empty.textContent = 'No events match this filter yet.';
    } else {
      empty.hidden = true;
    }
  }

  const onFilterChange = () => {
    activeFilter = filter.value;
    applyFilter();
  };
  filter.addEventListener('change', onFilterChange);

  function addTopic(topic) {
    if (!topic || knownTopics.has(topic)) return;
    knownTopics.add(topic);
    const option = el('option', '', topic);
    option.value = topic;
    filter.appendChild(option);
  }

  function addEvent(event) {
    const topic = event.shortTopic || event.topic || 'Event';
    addTopic(topic);

    const row = el('li', 'event-row');
    if (event.state === false) row.classList.add('event-row-inactive');
    const head = el('div', 'event-head');
    head.append(el('span', 'event-topic', topic), el('time', 'event-time', formatTime(event.utcTime)));
    row.appendChild(head);
    const detail = formatData(event.data);
    if (detail) row.appendChild(el('p', 'event-detail', detail));

    entries.unshift({ topic, row });
    list.prepend(row);
    while (entries.length > MAX_EVENTS) {
      const removed = entries.pop();
      removed.row.remove();
    }
    applyFilter();
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function connect() {
    if (destroyed) return;
    setState(reconnectAttempt > 0 ? 'Reconnecting' : 'Connecting', 'warn');
    socket = new WebSocket(wsUrl('/ws/events', { session: sessionId }));

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      setState('Live', 'ok');
      pingTimer = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
    });

    socket.addEventListener('message', (msg) => {
      let frame;
      try { frame = JSON.parse(msg.data); } catch { return; }
      switch (frame.type) {
        case 'event':
          addEvent(frame);
          break;
        case 'subscribed':
          setState('Live', 'ok');
          break;
        case 'resubscribing':
          setState(`Resubscribing (attempt ${frame.attempt})`, 'warn');
          break;
        case 'pong':
          break;
        case 'error':
          setState('Error', 'bad');
          onError({ code: frame.code || 'DEVICE_ERROR', message: frame.message || 'Event subscription failed.' });
          break;
      }
    });

    socket.addEventListener('close', (e) => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (destroyed) return;
      if (e.code === 4001) {
        // Session expired — the controller shell owns that transition.
        onError({ code: 'SESSION_EXPIRED', message: 'The session expired.' });
        return;
      }
      reconnectAttempt += 1;
      const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
      setState(`Disconnected — retrying in ${Math.round(delay / 1000)}s`, 'bad');
      reconnectTimer = setTimeout(connect, delay);
    });

    socket.addEventListener('error', () => {
      // The close event follows and drives the reconnect state.
    });
  }

  connect();

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      clearTimers();
      filter.removeEventListener('change', onFilterChange);
      if (socket) {
        socket.onclose = null;
        try { socket.close(); } catch { /* already closed */ }
        socket = null;
      }
    },
  };
}
