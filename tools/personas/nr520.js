/**
 * Persona: NR520 — an NVR with ONVIF administratively DISABLED.
 *
 * Observed on the real unit (GOVERNOR.md, Part 2):
 *   - every /onvif/* request gets a 404 — the service is off, not failing;
 *   - the Hikvision ISAPI answers on /ISAPI/* over HTTP digest auth (the same
 *     endpoints tools/probe-isapi.mjs walks);
 *   - recording is OFF on every track, so there is nothing to search.
 *
 * Digest follows the base mock's credential convention: any well-formed
 * Digest response is accepted (any username/password), no header at all gets
 * the 401 challenge. The observed trait is "digest required", not a password.
 */
import crypto from 'node:crypto';

const REALM = 'NR520';

export const persona = {
  name: 'nr520',
  create(ctx) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const challenge = `Digest realm="${REALM}", nonce="${nonce}", qop="auth"`;
    const count = (name) => { ctx.callCounts[name] = (ctx.callCounts[name] ?? 0) + 1; };

    function notFound(res) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }

    function passDigest(req, res) {
      const header = req.headers.authorization ?? '';
      const fields = Object.fromEntries(
        [...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      if (header.startsWith('Digest ') && fields.username && fields.response) return true;
      count('isapi.rejected');
      res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return false;
    }

    // Four tracks stand in for the channel list; the observed trait is that
    // Enable is false on EVERY one, so a recording probe finds nothing.
    function tracksXml() {
      const tracks = [1, 2, 3, 4].map((ch) => `<Track><id>${ch}01</id><Channel>${ch}</Channel><Enable>false</Enable>`
        + '<TrackDescriptor><TrackType>Video/Audio</TrackType></TrackDescriptor></Track>').join('');
      return `<?xml version="1.0" encoding="UTF-8"?><TrackList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">${tracks}</TrackList>`;
    }

    return {
      onRequest(req, res) {
        if (req.url.startsWith('/__')) return false;
        if (!req.url.startsWith('/ISAPI/')) {
          count('onvif.disabled');
          notFound(res);
          return true;
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          if (!passDigest(req, res)) return;
          if (req.url.startsWith('/ISAPI/System/deviceInfo')) {
            count('isapi.deviceInfo');
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end('<?xml version="1.0" encoding="UTF-8"?><DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">'
              + '<deviceName>NR520</deviceName><model>NR520</model></DeviceInfo>');
            return;
          }
          if (req.url.startsWith('/ISAPI/ContentMgmt/record/tracks')) {
            count('isapi.tracks');
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(tracksXml());
            return;
          }
          if (req.url.startsWith('/ISAPI/ContentMgmt/search')) {
            count('isapi.search');
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end('<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">'
              + '<numOfMatches>0</numOfMatches><searchStatus>OK</searchStatus><matchList/></CMSearchResult>');
            return;
          }
          notFound(res);
        });
        return true;
      },
    };
  },
};
