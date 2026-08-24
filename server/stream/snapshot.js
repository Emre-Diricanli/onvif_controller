import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';

function parseDigestChallenge(header) {
  if (!header || !/^Digest\s/i.test(header)) return null;
  const params = {};
  const input = header.replace(/^Digest\s+/i, '');
  for (const match of input.matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\"/g, '"');
  }
  return params.realm && params.nonce ? params : null;
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

function digestAuthorization(url, username, password, challenge) {
  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') {
    throw new AppError('UNSUPPORTED', `Snapshot authentication algorithm ${algorithm} is not supported.`, null, 502);
  }
  const qops = (challenge.qop || '').split(',').map((qop) => qop.trim().toLowerCase());
  const qop = qops.includes('auth') ? 'auth' : null;
  if (challenge.qop && !qop) throw new AppError('UNSUPPORTED', 'The camera requires an unsupported Digest authentication mode.', null, 502);
  const uri = `${url.pathname}${url.search}`;
  const cnonce = randomBytes(16).toString('hex');
  const nc = '00000001';
  let ha1 = md5(`${username}:${challenge.realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = md5(`GET:${uri}`);
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const fields = [
    `username="${username.replace(/["\\]/g, '\\$&')}"`,
    `realm="${challenge.realm.replace(/["\\]/g, '\\$&')}"`,
    `nonce="${challenge.nonce}"`, `uri="${uri}"`, `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(', ')}`;
}

async function request(url, options) {
  try {
    return await fetch(url, { ...options, redirect: 'follow' });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AppError('DEVICE_TIMEOUT', 'The camera did not return a snapshot within 10 seconds.', null, 504);
    }
    throw new AppError('DEVICE_UNREACHABLE', 'The camera snapshot endpoint could not be reached.', null, 502);
  }
}

export async function fetchSnapshot(session, profileToken) {
  const profile = session.profileMap.get(profileToken);
  if (!profile?.snapshotUri) throw new AppError('UNSUPPORTED', 'This media profile does not provide snapshots.', null, 404);
  let url;
  try { url = new URL(profile.snapshotUri); } catch {
    throw new AppError('DEVICE_ERROR', 'The camera returned an invalid snapshot URL.', null, 502);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('UNSUPPORTED', 'The camera snapshot URL uses an unsupported protocol.', null, 400);
  }
  url.username = '';
  url.password = '';
  const signal = AbortSignal.timeout(10_000);
  let response = await request(url, { signal });
  if (response.status === 401) {
    const challenge = parseDigestChallenge(response.headers.get('www-authenticate'));
    if (!challenge) throw new AppError('UNAUTHORIZED', 'The camera rejected snapshot authentication.', null, 401);
    const challengedUrl = new URL(response.url || url);
    const authorization = digestAuthorization(challengedUrl, session.username, session.password, challenge);
    response = await request(challengedUrl, { signal, headers: { Authorization: authorization } });
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError('UNAUTHORIZED', 'The camera rejected snapshot authentication.', null, 401);
  }
  if (!response.ok) throw new AppError('DEVICE_ERROR', `The camera snapshot request failed with HTTP ${response.status}.`, null, 502);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0] || 'image/jpeg';
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length) throw new AppError('DEVICE_ERROR', 'The camera returned an empty snapshot.', null, 502);
  return { contentType, body };
}
