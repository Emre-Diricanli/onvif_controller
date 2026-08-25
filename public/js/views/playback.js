import { api } from '../api.js';
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return 'not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function labeled(label, value) {
  const row = el('p', 'playback-detail');
  row.append(el('span', 'playback-label', `${label}: `), document.createTextNode(value));
  return row;
}

function renderServices(parent, services = {}) {
  const section = el('section', 'playback-services');
  section.appendChild(el('h3', 'playback-heading', 'Advertised services'));
  const list = el('ul', 'playback-service-list');
  for (const name of ['recording', 'replay', 'search']) {
    const service = services[name];
    const state = service?.present ? 'advertised' : 'not advertised';
    const origin = service?.present && service.origin ? ` (${service.origin})` : '';
    list.appendChild(el('li', 'playback-service', `${name[0].toUpperCase()}${name.slice(1)} — ${state}${origin}`));
  }
  section.appendChild(list);
  parent.appendChild(section);
}

function renderRecordings(parent, report) {
  const section = el('section', 'playback-recordings');
  const count = report.summary?.numberRecordings ?? report.recordings?.length ?? 0;
  section.appendChild(el('h3', 'playback-heading', `Recordings (${count})`));
  if (report.summary) {
    section.appendChild(labeled('Device-wide span', `${formatDate(report.summary.dataFrom)} to ${formatDate(report.summary.dataUntil)}`));
  }
  if (!report.recordings?.length) {
    section.appendChild(el('p', 'panel-status', 'The device returned no recording inventory.'));
  }
  for (const recording of report.recordings ?? []) {
    const card = el('article', 'playback-recording');
    card.appendChild(el('h4', 'playback-recording-title', recording.content || recording.source?.name || recording.token || 'Unnamed recording'));
    card.appendChild(labeled('Source identifier', recording.source?.sourceId ?? 'not reported'));
    if (recording.source?.location) card.appendChild(labeled('Location', recording.source.location));
    const tracks = recording.tracks ?? [];
    if (!tracks.length) card.appendChild(labeled('Time span', 'not reported'));
    for (const track of tracks) {
      const kind = track.type || track.description || 'Track';
      card.appendChild(labeled(kind, `${formatDate(track.dataFrom)} to ${formatDate(track.dataTo)}`));
    }
    section.appendChild(card);
  }
  parent.appendChild(section);
}

function renderMapping(parent, mapping) {
  const section = el('section', 'playback-mapping');
  section.appendChild(el('h3', 'playback-heading', 'Channel mapping'));
  if (mapping?.derivable) {
    section.appendChild(el('p', 'playback-mapping-status', 'Recording channels map to media profile channels by exact source-token matches.'));
    for (const match of mapping.matches ?? []) {
      section.appendChild(labeled('Mapped channel', `${match.recordingToken} → ${match.sourceToken}`));
    }
  } else {
    section.appendChild(el('p', 'playback-mapping-warning',
      'Channel mapping could not be derived. Recording source identifiers do not match media profile video source tokens, so guessing could show footage from the wrong camera.'));
    for (const source of mapping?.recordingSide ?? []) {
      section.appendChild(labeled('Recording source', source.sourceId ?? source.sourceName ?? source.recordingToken ?? 'not reported'));
    }
    for (const source of mapping?.profileSide ?? []) {
      section.appendChild(labeled('Media profile source', source.sourceToken ?? 'not reported'));
    }
  }
  parent.appendChild(section);
}

function renderReport(wrap, report) {
  wrap.replaceChildren();
  if (report.conclusion) wrap.appendChild(el('p', 'playback-conclusion', report.conclusion));
  renderServices(wrap, report.services);
  renderRecordings(wrap, report);
  renderMapping(wrap, report.channelMapping);
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, onError: (err: Error) => void }} opts
 * @returns {() => void}
 */
export function renderPlayback(container, { sessionId, onError }) {
  let destroyed = false;
  let wrap;

  const fail = (err) => {
    try { if (typeof onError === 'function') onError(err); } catch { /* errors stay inside the view */ }
    if (!wrap || destroyed) return;
    try { wrap.replaceChildren(el('p', 'panel-status', 'Playback information could not be read.')); } catch { /* no render path may throw */ }
  };

  try {
    wrap = el('section', 'playback');
    wrap.appendChild(el('p', 'panel-status', 'Probing recorded playback services…'));
    container.appendChild(wrap);
    api.getPlayback(sessionId).then((report) => {
      if (!destroyed) {
        try { renderReport(wrap, report); } catch (err) { fail(err); }
      }
    }).catch(fail);
  } catch (err) {
    fail(err);
  }

  return () => {
    destroyed = true;
    try { wrap?.remove(); } catch { /* cleanup is best effort */ }
  };
}
