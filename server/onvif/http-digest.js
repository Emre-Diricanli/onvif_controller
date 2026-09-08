import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import onvif from 'onvif';

const nonceCounts = new WeakMap();
const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const quote = (value) => String(value).replace(/(["\\])/g, '\\$1');

function parseChallenge(response) {
  if (![400, 401].includes(response.statusCode)) return null;
  for (const header of [].concat(response.headers['www-authenticate'] ?? [])) {
    const start = /(?:^|,\s*)Digest\s+/i.exec(header);
    if (!start) continue;
    const fields = {};
    const text = header.slice(start.index + start[0].length);
    const pattern = /\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))\s*(?:,|$)/gy;
    let match;
    while ((match = pattern.exec(text))) {
      fields[match[1].toLowerCase()] = match[2] === undefined
        ? match[3] : match[2].replace(/\\(.)/g, '$1');
    }
    const algorithm = (fields.algorithm ?? 'MD5').toUpperCase();
    if (fields.realm === undefined || !fields.nonce || !['MD5', 'MD5-SESS'].includes(algorithm)) continue;
    const qop = fields.qop?.split(',').map((value) => value.trim().toLowerCase());
    if (qop && !qop.includes('auth')) continue;
    return { ...fields, algorithm, qop: qop ? 'auth' : undefined };
  }
  return null;
}

function authorization(cam, challenge, method, uri) {
  let counts = nonceCounts.get(cam);
  if (!counts) nonceCounts.set(cam, counts = new Map());
  const key = JSON.stringify([challenge.realm, challenge.nonce]);
  const count = (counts.get(key) ?? 0) + 1;
  if (count > 0xffffffff) throw new Error('HTTP Digest nonce count exhausted');
  counts.set(key, count);
  const nc = count.toString(16).padStart(8, '0');
  const cnonce = randomBytes(16).toString('hex');
  const { realm, nonce, qop, opaque, algorithm } = challenge;
  let ha1 = md5(`${cam.username ?? ''}:${realm}:${cam.password ?? ''}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(qop ? `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${nonce}:${ha2}`);
  const fields = [
    `username="${quote(cam.username ?? '')}"`, `realm="${quote(realm)}"`,
    `nonce="${quote(nonce)}"`, `uri="${quote(uri)}"`, `response="${response}"`,
    `algorithm=${algorithm === 'MD5-SESS' ? 'MD5-sess' : 'MD5'}`,
  ];
  if (opaque !== undefined) fields.push(`opaque="${quote(opaque)}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`);
  if (qop || algorithm === 'MD5-SESS') fields.push(`cnonce="${cnonce}"`);
  return `Digest ${fields.join(', ')}`;
}

function request(cam, options, challenge) {
  return new Promise((resolve) => {
    let headers = {};
    let statusCode;
    const context = Object.create(cam);
    context.emit = cam.emit.bind(cam);
    context._requestPart2 = function (prepared, callback) {
      // Match _requestPart2's URL/service precedence, including parsed URL.path.
      const url = { ...(prepared.url || {
        hostname: cam.hostname, port: cam.port, agent: cam.agent,
        path: prepared.service ? (cam.uri[prepared.service] ? cam.uri[prepared.service].path : prepared.service) : cam.path,
        timeout: cam.timeout,
      }) };
      const transport = cam.useSecure ? https : http;
      const configuredAgent = url.agent === undefined && cam.useSecure ? cam.secureOpts?.agent : url.agent;
      const agent = configuredAgent === false ? new transport.Agent({ keepAlive: false }) : (configuredAgent ?? transport.globalAgent);
      // Delegate sockets to the original agent; never patch global HTTP state.
      const adapter = Object.create(agent);
      adapter.addRequest = (req, rawOptions) => {
        if (challenge) req.setHeader('Authorization', authorization(cam, challenge, req.method, req.path));
        req.once('response', (res) => {
          headers = res.headers;
          statusCode = res.statusCode;
        });
        agent.addRequest(req, { ...rawOptions, agent });
      };
      url.agent = adapter;
      onvif.Cam.prototype._requestPart2.call(context, { ...prepared, url }, callback);
    };
    const done = (err, data, xml, code) => resolve({ err, data, xml, statusCode: statusCode ?? code, headers });
    try {
      onvif.Cam.prototype._request.call(context, { ...options }, done);
    } catch (err) {
      done(err);
    }
  });
}

/**
 * Resolve to { err, data, xml, statusCode, headers }; the first four fields map
 * to ONVIF's callback. Only an observed Digest challenge permits a retry.
 * Bodies stay intact: a device may need Digest AND a WS-Security token, which
 * the connect path can supply through requestOptions.body.
 */
export async function requestWithHttpDigest(cam, requestOptions) {
  const original = await request(cam, requestOptions);
  let challenge = parseChallenge(original);
  if (!challenge) return original;
  // One additional retry handles an expired nonce without an unbounded loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(cam, requestOptions, challenge);
    if (!response.err && response.statusCode >= 200 && response.statusCode < 300) return response;
    const next = parseChallenge(response);
    if (next?.stale?.toLowerCase() !== 'true') break;
    challenge = next;
  }
  return original;
}

export default requestWithHttpDigest;
