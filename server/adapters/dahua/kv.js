/**
 * Dahua CGI text format helpers.
 *
 * Every Dahua HTTP API (CGI) answer is plain text, one `key=value` per line:
 *
 *   table.VideoColor[0][0].Brightness=50\r\n
 *   type=IPC-HDW2431T-AS-S2\r\n
 *
 * Real firmware ends lines with CRLF, sometimes leaves a trailing blank line,
 * and values may themselves contain '=' (channel titles, version strings with
 * `,build:` suffixes, base64 blobs), so a line is split on the FIRST '=' only.
 * A refusal is a body starting with `Error` (often `Error\r\nBad Request!`),
 * usually with status 400 but not reliably so — the body is the signal.
 */

/** Parse a key=value body into a Map, in device order. Keys are trimmed; values are kept verbatim. */
export function parseKeyValue(text) {
  const out = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out.set(key, line.slice(eq + 1));
  }
  return out;
}

/**
 * Parse a configManager getConfig answer. Firmware prefixes every key with
 * `table.`; the prefix is stripped so the keys are exactly the paths that
 * setConfig takes back (`VideoColor[0][0].Brightness`).
 */
export function parseTable(text) {
  const out = new Map();
  for (const [key, value] of parseKeyValue(text)) {
    out.set(key.startsWith('table.') ? key.slice('table.'.length) : key, value);
  }
  return out;
}

/** True when the device refused the request in its own words. */
export function isErrorBody(text) {
  return /^\s*Error\b/i.test(String(text ?? ''));
}

/** True when a setConfig answer is the documented acceptance (`OK`). */
export function isOkBody(text) {
  return /^\s*OK\s*$/i.test(String(text ?? ''));
}
