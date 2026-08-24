import { createHash } from 'node:crypto';

export const VATILON_DIGEST_DEFAULTS = Object.freeze({
  realm: 'CAMERA',
  nonce: 'b6ef824ee4090bbd124a4ccb39c5333a',
  qop: 'auth',
  uri: '/cgi-bin/web.cgi?mod=account&cmd=check',
  method: 'GET',
  nc: '00000001',
});

const md5 = (value) => createHash('md5').update(value, 'utf8').digest('hex');
const quote = (value) => String(value).replace(/(["\\])/g, '\\$1');

/**
 * Build the non-standard Digest header used by Vatilon firmware.
 *
 * This is deliberately pure: callers provide a cnonce (normally generated for
 * each login), while the firmware's observed hard-coded values remain
 * overridable for future revisions. `uri` is the digest URI, not the login URL.
 */
export function buildDigestAuthorization(username, password, {
  realm = VATILON_DIGEST_DEFAULTS.realm,
  nonce = VATILON_DIGEST_DEFAULTS.nonce,
  qop = VATILON_DIGEST_DEFAULTS.qop,
  uri = VATILON_DIGEST_DEFAULTS.uri,
  method = VATILON_DIGEST_DEFAULTS.method,
  nc = VATILON_DIGEST_DEFAULTS.nc,
  cnonce,
} = {}) {
  if (cnonce === undefined || cnonce === null || cnonce === '') {
    throw new TypeError('A cnonce is required to build a Vatilon digest header.');
  }

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return `Digest username="${quote(username)}", realm="${quote(realm)}", nonce="${quote(nonce)}", uri="${quote(uri)}", response="${response}", qop=${qop}, nc=${nc}, cnonce="${quote(cnonce)}"`;
}
