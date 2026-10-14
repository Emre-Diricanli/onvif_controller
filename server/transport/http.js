/**
 * Governed HTTP client for device adapters (ADAPTERS.md §7).
 * Each wire exchange owns one governor submission; authentication retries are
 * outside that slot so parallel challenges cannot deadlock a recorder.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { AppError } from '../errors.js';
import { withGovernor, PRIORITY } from '../device/governor.js';

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const quote = (value) => String(value).replace(/(["\\])/g, '\\$1');

/** Commas in quoted realms and qop lists are not challenge boundaries. */
export function parseChallenges(headerValue) {
  const out = [];
  for (const header of [].concat(headerValue ?? [])) {
    const parts = String(header).match(/(?:[^,"\\]|"(?:\\.|[^"\\])*"|\\.)+/g) ?? [];
    let current = null;
    for (const part of parts) {
      const start = /^\s*([\w-]+)\s+(?!\s*=)(.*)$/s.exec(part);
      let params = part;
      if (start) {
        current = { scheme: start[1].toLowerCase() };
        if (['digest', 'basic'].includes(current.scheme)) out.push(current);
        params = start[2];
      }
      if (!current) continue;
      const field = /^\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))\s*$/.exec(params);
      if (field) current[field[1].toLowerCase()] = field[2] === undefined ? field[3] : field[2].replace(/\\(.)/g, '$1');
    }
  }
  return out;
}

export function isSupportedDigest(challenge) {
  return challenge?.scheme === 'digest' && challenge.realm !== undefined && Boolean(challenge.nonce)
    && ['MD5', 'MD5-SESS'].includes((challenge.algorithm ?? 'MD5').toUpperCase())
    && (challenge.qop === undefined || challenge.qop.split(',').some((q) => q.trim().toLowerCase() === 'auth'));
}

export function digestAuthorization({ username, password, method, uri, challenge, nc = 1, cnonce = randomBytes(16).toString('hex') }) {
  if (!isSupportedDigest({ ...challenge, scheme: 'digest' })) {
    throw new AppError('UNAUTHORIZED', 'The device requested an unsupported Digest algorithm or quality of protection.');
  }
  if (!Number.isInteger(nc) || nc < 1 || nc > 0xffffffff) {
    throw new AppError('UNAUTHORIZED', 'The HTTP Digest nonce count is exhausted or invalid.');
  }
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  const qop = challenge.qop === undefined ? undefined : 'auth';
  const ncHex = nc.toString(16).padStart(8, '0');
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(qop ? `${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}` : `${ha1}:${challenge.nonce}:${ha2}`);
  return `Digest username="${quote(username)}", realm="${quote(challenge.realm)}", nonce="${quote(challenge.nonce)}", uri="${quote(uri)}", `
    + `algorithm=${algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5'}, response="${response}"`
    + (qop ? `, qop=${qop}, nc=${ncHex}` : '')
    + (qop || algorithm === 'MD5-SESS' ? `, cnonce="${quote(cnonce)}"` : '')
    + (challenge.opaque !== undefined ? `, opaque="${quote(challenge.opaque)}"` : '');
}

/** Revisited nonces keep their counts, including a stale challenge reusing one. */
export function createDigestState() {
  const nonces = new Map();
  return {
    authorization(options) {
      const key = JSON.stringify([options.challenge.realm, options.challenge.nonce]);
      let state = nonces.get(key);
      if (!state) {
        state = { nc: 0, cnonce: randomBytes(16).toString('hex') };
        nonces.set(key, state);
      }
      return digestAuthorization({ ...options, nc: ++state.nc, cnonce: state.cnonce });
    },
    clear() { nonces.clear(); },
  };
}

/** Never echo native errors: their messages can contain URLs or header values. */
function mapNetworkError(err) {
  if (err instanceof AppError) return err;
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(err?.code) || err?.name === 'TimeoutError') {
    return new AppError('DEVICE_TIMEOUT', 'The device did not answer in time.');
  }
  if (['ERR_INVALID_CHAR', 'ERR_INVALID_HTTP_TOKEN', 'ERR_UNESCAPED_CHARACTERS', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE'].includes(err?.code)) {
    return new AppError('BAD_REQUEST', 'The HTTP request contains invalid options.');
  }
  return new AppError('DEVICE_UNREACHABLE', 'Could not reach the device.');
}

const cancelled = () => new AppError('DEVICE_ERROR', 'The device request was cancelled.');
const connectionClosed = () => new AppError('SESSION_EXPIRED', 'This device connection was closed.');
const validTimeout = (value) => Number.isFinite(value) && value > 0 && value <= 0x7fffffff;

export function createHttpClient({
  host, port, scheme = 'http', username = '', password = '',
  auth = 'auto', timeoutMs = 8000, maxBodyBytes = 4 * 1024 * 1024, insecureTls = false,
} = {}) {
  if (typeof host !== 'string' || !host || /[\s/?#@]/.test(host)) throw new AppError('BAD_REQUEST', 'A device hostname or IP address is required.');
  if (!['http', 'https'].includes(scheme) || !['auto', 'digest', 'basic', 'none'].includes(auth)
    || !validTimeout(timeoutMs) || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new AppError('BAD_REQUEST', 'Invalid device transport configuration.');
  }
  port ??= scheme === 'https' ? 443 : 80;
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new AppError('BAD_REQUEST', 'Invalid device port.');
  const lib = scheme === 'https' ? https : http;
  const digest = createDigestState();
  const active = new Set();
  let challenge = null;
  let closed = false;

  function exchange({ method, path, createHeaders, body, timeoutMs: deadline, priority, abortSignal }) {
    return withGovernor(host, () => new Promise((resolve, reject) => {
      if (closed) return reject(connectionClosed());
      if (abortSignal?.aborted) return reject(cancelled());
      let req;
      let timer;
      let settled = false;
      const finish = (err, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abort);
        active.delete(stop);
        if (err) reject(mapNetworkError(err));
        else resolve(response);
      };
      const stop = (err) => { finish(err); req?.destroy(); };
      const abort = () => stop(cancelled());
      active.add(stop);
      abortSignal?.addEventListener('abort', abort, { once: true });
      // A wall-clock deadline also bounds DNS, TLS setup and trickling bodies.
      timer = setTimeout(() => stop(new AppError('DEVICE_TIMEOUT', 'The device did not answer in time.')), deadline);
      try {
        req = lib.request({ host, port, path, method, headers: createHeaders(), rejectUnauthorized: !insecureTls }, (res) => {
          const chunks = [];
          let size = 0;
          const tooLarge = () => stop(new AppError('DEVICE_ERROR', 'The device response exceeded the configured body limit.'));
          res.on('error', (err) => finish(err));
          res.on('aborted', () => finish(new AppError('DEVICE_UNREACHABLE', 'The device closed an incomplete response.')));
          if (Number(res.headers['content-length']) > maxBodyBytes) { tooLarge(); return; }
          res.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBodyBytes) { tooLarge(); return; }
            chunks.push(chunk);
          });
          res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
        });
        req.on('error', (err) => finish(err));
        req.end(body);
      } catch (err) { stop(mapNetworkError(err)); }
    }), { priority: priority ?? PRIORITY.normal, label: `${method} adapter` });
  }

  async function perform({ method = 'GET', path = '/', headers = {}, body, timeoutMs: perCall, priority, abortSignal } = {}) {
    if (closed) throw connectionClosed();
    if (abortSignal?.aborted) throw cancelled();
    const deadline = perCall ?? timeoutMs;
    if (!validTimeout(deadline) || typeof path !== 'string' || !path.startsWith('/') || /[\r\n]/.test(path)
      || typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)
      || !headers || typeof headers !== 'object' || Array.isArray(headers)) throw new AppError('BAD_REQUEST', 'Invalid HTTP request options.');
    method = method.toUpperCase();
    let payload = body;
    const baseHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    try {
      if (payload !== undefined && payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
        payload = JSON.stringify(payload);
        baseHeaders['content-type'] ??= 'application/json';
      }
      if (payload !== undefined && payload !== null) {
        if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) throw new AppError('BAD_REQUEST', 'The HTTP body must be a string, Buffer or JSON object.');
        baseHeaders['content-length'] = Buffer.byteLength(payload);
        delete baseHeaders['transfer-encoding'];
      } else payload = undefined;
    } catch { throw new AppError('BAD_REQUEST', 'The HTTP body could not be encoded.'); }

    const send = (selected) => {
      // Allocate nc at dispatch, not submission: governor priorities can reorder
      // queued requests, and cameras may reject a lower count as a replay.
      const createHeaders = () => {
        const wireHeaders = { ...baseHeaders };
        if (selected?.scheme === 'digest') wireHeaders.authorization = digest.authorization({ username, password, method, uri: path, challenge: selected });
        if (selected?.scheme === 'basic') wireHeaders.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        return wireHeaders;
      };
      return exchange({ method, path, createHeaders, body: payload, timeoutMs: deadline, priority, abortSignal });
    };
    // Basic credentials are sent only in response to this request's challenge.
    let selected = auth === 'none' ? null : challenge;
    let res = await send(selected);
    let refreshed = false;
    while (res.status === 401 && auth !== 'none') {
      const offered = parseChallenges(res.headers['www-authenticate']);
      const offeredDigest = offered.find(isSupportedDigest);
      const basic = offered.find((c) => c.scheme === 'basic');
      const pick = auth === 'basic' ? basic : auth === 'digest' ? offeredDigest : (offeredDigest ?? basic);
      const renewal = selected?.scheme === 'digest' && pick?.scheme === 'digest'
        && (pick.nonce !== selected.nonce || pick.stale?.toLowerCase() === 'true');
      // One initial authentication and at most one expired/new-nonce retry.
      // Repeating the same failed credentials cannot repair a wrong password.
      if (!pick || (selected && (!renewal || refreshed))) {
        if (challenge === selected) challenge = null;
        throw new AppError('UNAUTHORIZED', 'The device rejected the credentials.');
      }
      if (selected) refreshed = true;
      selected = pick;
      if (pick.scheme === 'digest') challenge = pick;
      res = await send(pick);
    }
    const text = res.buffer.toString('utf8');
    return {
      status: res.status, headers: res.headers, text,
      json() {
        try { return JSON.parse(text); } catch { throw new AppError('DEVICE_ERROR', 'The device returned malformed JSON.'); }
      },
    };
  }

  /** Queued cancellation settles promptly; its governor callback sends no bytes. */
  function request(options = {}) {
    if (!options || typeof options !== 'object') return Promise.reject(new AppError('BAD_REQUEST', 'Invalid HTTP request options.'));
    const signal = options.abortSignal;
    if (signal && (!(signal instanceof AbortSignal))) return Promise.reject(new AppError('BAD_REQUEST', 'Invalid HTTP abort signal.'));
    if (!signal) return perform(options);
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const abort = () => reject(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      perform(options).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  return {
    request,
    close() {
      closed = true;
      challenge = null;
      digest.clear();
      for (const stop of active) stop(connectionClosed());
    },
  };
}
