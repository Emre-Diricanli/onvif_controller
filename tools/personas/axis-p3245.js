/**
 * Persona: AXIS P3245-LV — the camera the Axis VAPIX adapter is verified
 * against (tools/tests/axis.mjs). Single sensor I0, HTTP Digest (RFC 2617,
 * qop=auth) for the harness credentials, exactly as Axis firmware challenges.
 *
 * Modes (ctx.mode):
 *   default: param.cgi updates validate and land; reads see them.
 *   ignore:  updates answer "OK" but change nothing — the ONVIF-stub
 *            signature the contract requires every adapter to surface as
 *            outcome "unchanged".
 *   reject:  any update to root.ImageSource.I0.Sensor.Brightness answers
 *            "# Error: parameter rejected" (per-field refusal, no status
 *            code) so the adapter's rejected-outcome path is exercised.
 */
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

export const persona = {
  name: 'axis-p3245',
  vendor: 'axis',
  create(ctx) {
    const realm = 'AXIS_P3245';
    const nonce = randomBytes(8).toString('hex');
    const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };

    // The full param store, keyed by complete param.cgi path. VAPIX param.cgi
    // is text-based: reads and writes both address these paths directly.
    const entries = [
      ['root.Brand.Brand', 'AXIS'],
      ['root.ImageSource.I0.Sensor.Brightness', '50'],
      ['root.ImageSource.I0.Sensor.Contrast', '50'],
      ['root.ImageSource.I0.Sensor.ColorLevel', '50'],
      ['root.ImageSource.I0.Sensor.Sharpness', '50'],
      ['root.ImageSource.I0.Sensor.WDR', 'off'],
      ['root.ImageSource.I0.DayNight.DayNightColor', 'auto'],
      ['root.ImageSource.I0.IrCutFilter.IrCutFilter', 'auto'],
      ['root.Image.I0.Appearance.Mirror', 'no'],
      ['root.Image.I0.Appearance.Resolution', '1920x1080'],
      ['root.Image.I0.Appearance.Rotation', '0'],
      ['root.Image.I0.Stream.FPS', '25'],
      ['root.Image.I0.Stream.Codec', 'h264'],
      ['root.Image.I0.Stream.Compression', '50'],
      ['root.Image.I0.RateControl.Mode', 'vbr'],
      ['root.Image.I0.RateControl.TargetBitrate', '2048'],
    ];
    const params = new Map(entries);
    // Stable listing order, so action=list answers are deterministic.
    const paths = entries.map(([p]) => p);

    // RFC 2617 qop=auth verification, same construction as the harness
    // self-test. The password is only ever used inside the HA1 hash — it is
    // never echoed into a response or a log line.
    function authorized(req) {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Digest ')) return false;
      const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      if (f.username !== ctx.username) return false;
      const ha1 = md5(`${ctx.username}:${realm}:${ctx.password}`);
      const ha2 = md5(`${req.method}:${f.uri}`);
      return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
    }

    function text(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(body);
    }

    return {
      onRequest(req, res) {
        const url = new URL(req.url, 'http://persona');
        if (!url.pathname.startsWith('/axis-cgi/')) return false;
        if (!authorized(req)) {
          res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` });
          res.end();
          return true;
        }
        if (url.pathname === '/axis-cgi/basicdeviceinfo.cgi' && req.method === 'POST') {
          count('basicdeviceinfo');
          req.resume(); // drain the request body; the answer never needs it
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            apiVersion: '1.0',
            method: 'getAllProperties',
            data: {
              propertyList: {
                Brand: 'AXIS',
                ProdNbr: 'P3245',
                ProdFullName: 'AXIS P3245-LV',
                Version: '10.12.65',
              },
            },
          }));
          return true;
        }
        if (url.pathname === '/axis-cgi/param.cgi' && req.method === 'GET' && url.searchParams.get('action') === 'list') {
          count('param.list');
          const group = url.searchParams.get('group') ?? '';
          const lines = paths.filter((p) => p.startsWith(`${group}.`)).map((p) => `${p}=${params.get(p)}`);
          text(res, 200, lines.join('\n'));
          return true;
        }
        if (url.pathname === '/axis-cgi/param.cgi' && req.method === 'GET' && url.searchParams.get('action') === 'update') {
          count('param.update');
          const lines = [];
          for (const [path, value] of url.searchParams.entries()) {
            if (path === 'action') continue;
            if (!params.has(path)) {
              lines.push('# Error: parameter not found');
              continue;
            }
            if (ctx.mode === 'reject' && path === 'root.ImageSource.I0.Sensor.Brightness') {
              lines.push('# Error: parameter rejected');
              continue;
            }
            if (ctx.mode === 'ignore') {
              lines.push('OK');
              continue;
            }
            // Light validation, matching what real firmware does for a
            // malformed value: a param that holds a number keeps a number.
            if (/^-?\d+$/.test(params.get(path)) && !/^-?\d+$/.test(value)) {
              lines.push('# Error: invalid value');
              continue;
            }
            params.set(path, value);
            lines.push('OK');
          }
          text(res, 200, lines.join('\n'));
          return true;
        }
        return false;
      },
    };
  },
};
