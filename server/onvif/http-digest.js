import http from 'node:http';
import https from 'node:https';
import onvif from 'onvif';
import { AppError, mapOnvifError } from '../errors.js';
import { withGovernor } from '../device/governor.js';
import { parseChallenges, isSupportedDigest, createDigestState } from '../transport/http.js';

/**
 * HTTP Digest bridge for ONVIF firmware that also requires WS-Security.
 * The library still prepares and parses SOAP; only its instance-local request
 * agent gets the Authorization header. Global HTTP/prototype state is untouched.
 * Digest parsing, calculation and nonce counts are shared with adapter transport.
 */
const digestStates = new WeakMap();
const installations = new WeakMap();

function parseChallenge(response) {
  if (![400, 401].includes(response.statusCode)) return null;
  return parseChallenges(response.headers['www-authenticate']).find(isSupportedDigest) ?? null;
}

function authorization(cam, challenge, method, uri) {
  let state = digestStates.get(cam);
  if (!state) digestStates.set(cam, state = createDigestState());
  return state.authorization({ username: cam.username ?? '', password: cam.password ?? '', method, uri, challenge });
}

function requestUngoverned(cam, options, challenge) {
  return new Promise((resolve) => {
    let headers = {};
    let statusCode;
    const context = Object.create(cam);
    context.emit = cam.emit.bind(cam);
    context._requestPart2 = function (prepared, callback) {
      // Match _requestPart2's URL/service precedence, including parsed URL.path.
      const url = { ...(prepared.url || {
        hostname: cam.hostname, port: cam.port, agent: cam.agent,
        path: prepared.service ? (cam.uri?.[prepared.service]?.path ?? prepared.service) : cam.path,
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
    const done = (err, data, xml, code) => {
      if (err && !(err instanceof AppError)) {
        // SOAP fault text is device-controlled and can echo credentials. Keep
        // the stable classification, but never expose that text as an error.
        err = mapOnvifError({ message: err.message, code: err.code, statusCode: statusCode ?? code });
        err.hint = null;
      }
      resolve({ err, data, xml, statusCode: statusCode ?? code, headers });
    };
    try {
      onvif.Cam.prototype._request.call(context, { ...options }, done);
    } catch (err) {
      done(err);
    }
  });
}

/** Each SOAP exchange, including each challenge retry, gets exactly one slot. */
async function request(cam, options, challenge) {
  const host = options.url?.hostname ?? options.url?.host ?? cam.hostname;
  try {
    return await withGovernor(host, async () => {
      const response = await requestUngoverned(cam, options, challenge);
      if (response.err && (!response.statusCode || ['DEVICE_TIMEOUT', 'DEVICE_UNREACHABLE'].includes(response.err.code))) {
        const code = /timeout/i.test(response.err.message ?? '') ? 'DEVICE_TIMEOUT' : 'DEVICE_UNREACHABLE';
        throw response.err instanceof AppError ? response.err : new AppError(code,
          code === 'DEVICE_TIMEOUT' ? 'The device did not answer in time.' : 'Could not reach the device.');
      }
      return response;
    }, { priority: options.priority, label: 'ONVIF HTTP Digest' });
  } catch (err) {
    return { err, data: undefined, xml: undefined, statusCode: undefined, headers: {} };
  }
}

/**
 * Resolve to { err, data, xml, statusCode, headers }; the first four fields map
 * to ONVIF's callback. Only an observed Digest challenge permits a retry.
 * Bodies stay intact: a device may need Digest AND a WS-Security token.
 * As before, failed authentication returns the original challenge response.
 * Do not wrap this call in withGovernor: every exchange is already governed.
 */
export async function requestWithHttpDigest(cam, requestOptions) {
  const original = await request(cam, requestOptions);
  let challenge = parseChallenge(original);
  if (!challenge) return original;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(cam, requestOptions, challenge);
    if (!response.err && response.statusCode >= 200 && response.statusCode < 300) return response;
    // A transport/governor failure must survive; disguising DEVICE_BUSY as the
    // original 401 would tell the operator to change perfectly good credentials.
    if (!response.statusCode && response.err) return response;
    const next = parseChallenge(response);
    if (!next || (next.stale?.toLowerCase() !== 'true' && next.nonce === challenge.nonce)) break;
    challenge = next;
  }
  return original;
}

/** Whether this instance owns governor submissions at the HTTP exchange layer. */
export function hasHttpDigestTransport(cam) {
  return installations.has(cam);
}

/**
 * Stream 1 wiring: create a Cam with autoconnect:false, enableHttpDigest(cam),
 * then start discovery. In util.callCam and raw SOAP wrappers (device, imaging,
 * network, playback), bypass their OUTER withGovernor when
 * hasHttpDigestTransport(cam) is true. Never nest those slots around this patch.
 * Pass request priority through options.priority where relevant.
 * Returns an idempotent restore function; only this instance is patched.
 */
export function enableHttpDigest(cam) {
  if (installations.has(cam)) return installations.get(cam);
  const own = Object.getOwnPropertyDescriptor(cam, '_request');
  cam._request = function (options, callback) {
    if (typeof callback !== 'function') throw new AppError('BAD_REQUEST', 'An ONVIF callback is required.');
    requestWithHttpDigest(this, options).then(
      ({ err, data, xml, statusCode }) => callback.call(this, err, data, xml, statusCode),
      (err) => callback.call(this, err),
    );
  };
  const restore = () => {
    if (!installations.has(cam)) return;
    if (own) Object.defineProperty(cam, '_request', own);
    else delete cam._request;
    installations.delete(cam);
    digestStates.delete(cam);
  };
  installations.set(cam, restore);
  return restore;
}

export default requestWithHttpDigest;
