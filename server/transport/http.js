/**
 * Governed HTTP client for device adapters (ADAPTERS.md §7).
 *
 * The only way an adapter talks to a device. Every exchange (including each
 * leg of a digest challenge) is submitted through the per-host governor, so a
 * new adapter cannot reintroduce the AR504-32 wedge.
 *
 * Step-0 reference implementation: the interface is frozen; the transport
 * stream owns hardening (TLS policy, redirects, cancellation, nc tracking
 * across requests, consolidation with server/onvif/http-digest.js).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { AppError } from '../errors.js';
import { withGovernor, PRIORITY } from '../device/governor.js';

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const quote = (value) => String(value).replace(/(["\\])/g, '\\$1');

export function parseChallenges(headerValue) {
  const out = [];
  for (const header of [].concat(headerValue ?? [])) {
    const scheme = /^\s*(Digest|Basic)\b/i.exec(header);
    if (!scheme) continue;
    const fields = {};
    const pattern = /([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g;
    let match;
    while ((match = pattern.exec(header.slice(scheme[0].length)))) {
      fields[match[1].toLowerCase()] = match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, '$1');
    }
    out.push({ scheme: scheme[1].toLowerCase(), ...fields });
  }
  return out;
}

export function digestAuthorization({ username, password, method, uri, challenge, nc, cnonce }) {
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  const qops = challenge.qop?.split(',').map((q) => q.trim().toLowerCase());
  const qop = qops?.includes('auth') ? 'auth' : undefined;
  const ncHex = nc.toString(16).padStart(8, '0');
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(qop ? `${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}` : `${ha1}:${challenge.nonce}:${ha2}`);
  return `Digest username="${quote(username)}", realm="${quote(challenge.realm)}", nonce="${quote(challenge.nonce)}", uri="${quote(uri)}", `
    + `algorithm=${algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5'}, response="${response}"`
    + (qop ? `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"` : '')
    + (challenge.opaque !== undefined ? `, opaque="${quote(challenge.opaque)}"` : '');
}

function mapNetworkError(err, host) {
  if (err instanceof AppError) return err;
  if (err?.code === 'ETIMEDOUT' || err?.name === 'TimeoutError') return new AppError('DEVICE_TIMEOUT', `${host} did not answer in time.`);
  return new AppError('DEVICE_UNREACHABLE', `Could not reach ${host}.`);
}

export function createHttpClient({
  host, port = 80, scheme = 'http', username = '', password = '',
  auth = 'auto', timeoutMs = 8000, maxBodyBytes = 4 * 1024 * 1024, insecureTls = false,
} = {}) {
  if (!host) throw new AppError('BAD_REQUEST', 'A device host is required.');
  const lib = scheme === 'https' ? https : http;
  let challenge = null;   // last digest challenge, reused with an incrementing nc
  let nc = 0;
  let closed = false;

  function exchange({ method, path, headers, body, timeoutMs: perCall, priority }) {
    const deadline = perCall ?? timeoutMs;
    return withGovernor(host, () => new Promise((resolve, reject) => {
      const req = lib.request({
        host, port, path, method, headers,
        // Verify by default. Cameras commonly ship self-signed certs; an operator
        // must opt in per connection, never by default.
        rejectUnauthorized: !insecureTls,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBodyBytes) {
            req.destroy();
            reject(new AppError('DEVICE_ERROR', `${host} sent a response larger than ${maxBodyBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
        res.on('error', (err) => reject(mapNetworkError(err, host)));
      });
      req.setTimeout(deadline, () => {
        const err = new Error('timeout');
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.on('error', (err) => reject(mapNetworkError(err, host)));
      if (body !== undefined) req.write(body);
      req.end();
    }), { priority: priority ?? PRIORITY.normal, label: `${method} adapter` });
  }

  function authHeader(method, path) {
    if (!challenge) return null;
    if (challenge.scheme === 'basic') return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    nc += 1;
    return digestAuthorization({ username, password, method, uri: path, challenge, nc, cnonce: randomBytes(8).toString('hex') });
  }

  async function request({ method = 'GET', path = '/', headers = {}, body, timeoutMs: perCall, priority } = {}) {
    if (closed) throw new AppError('SESSION_EXPIRED', 'This device connection was closed.');
    let payload = body;
    const baseHeaders = { ...headers };
    if (payload !== undefined && payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
      payload = JSON.stringify(payload);
      baseHeaders['Content-Type'] ??= 'application/json';
    }
    if (payload !== undefined && payload !== null) baseHeaders['Content-Length'] = Buffer.byteLength(payload);
    else payload = undefined;

    const send = (authorization) => exchange({
      method, path, body: payload, timeoutMs: perCall, priority,
      headers: authorization ? { ...baseHeaders, Authorization: authorization } : baseHeaders,
    });

    let res = await send(auth === 'none' ? null : authHeader(method, path));
    if (res.status === 401 && auth !== 'none') {
      const offered = parseChallenges(res.headers['www-authenticate']);
      const digest = offered.find((c) => c.scheme === 'digest' && c.nonce !== undefined);
      const basic = offered.find((c) => c.scheme === 'basic');
      const pick = auth === 'basic' ? basic : auth === 'digest' ? digest : (digest ?? basic);
      if (pick) {
        const stale = challenge && challenge.scheme === 'digest' && pick.nonce !== challenge.nonce;
        challenge = pick;
        if (stale || pick.scheme === 'digest') nc = 0;
        res = await send(authHeader(method, path));
      }
      if (res.status === 401) throw new AppError('UNAUTHORIZED', `${host} rejected the credentials.`);
    }
    const text = res.buffer.toString('utf8');
    return {
      status: res.status,
      headers: res.headers,
      text,
      json() {
        try { return JSON.parse(text); } catch { throw new AppError('DEVICE_ERROR', `${host} returned malformed JSON.`); }
      },
    };
  }

  return {
    request,
    close() { closed = true; challenge = null; },
  };
}
