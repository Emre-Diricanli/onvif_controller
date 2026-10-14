/**
 * Persona: Uniview IPC speaking the LiteAPI (LAPI) V1.0.
 *
 * All paths live under /LAPI/V1.0 and answer the LAPI JSON envelope:
 *   {"Response":{"ResponseURL":..., "ResponseCode":0, "StatusCode":...,
 *                "StatusString":"...", "Data":{...}}}
 * ResponseCode != 0 means the request failed at the application level, even
 * when the HTTP status is 200 — the "reject" mode leans on that quirk.
 *
 * Auth is RFC 2617 HTTP Digest (qop=auth) exactly as a real Uniview IPC
 * enforces it; anything without a valid Digest answer gets the 401 challenge.
 * Path shapes and field names are // assumed from vendor docs, not
 * hardware-verified — Uniview firmware varies and LAPI docs are per-series.
 */
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const REALM = 'UNV_IPC';

const DEFAULTS = {
  basic: { Brightness: 50, Contrast: 50, Saturation: 50, Sharpness: 50 },
  dayNight: { DayNightMode: 'auto' },
  encoder: [
    { VideoStreamType: 'major', EncodeFormat: 'H.264', Resolution: '1920*1080', FrameRate: 25, BitRate: 4096, BitRateType: 'CBR', GOP: 50 },
    { VideoStreamType: 'minor', EncodeFormat: 'H.264', Resolution: '640*360', FrameRate: 15, BitRate: 512, BitRateType: 'VBR', GOP: 50 },
  ],
};

function envelope(data, extra = {}) {
  return JSON.stringify({
    Response: { ResponseCode: 0, StatusString: 'OK', ...extra, ...(data !== undefined ? { Data: data } : {}) },
  });
}

export const persona = {
  name: 'uniview-ipc',
  vendor: 'uniview',
  create(ctx) {
    const nonce = randomBytes(16).toString('hex');
    // Fresh per boot, like a device that was just powered on.
    const state = {
      basic: { ...DEFAULTS.basic },
      dayNight: { ...DEFAULTS.dayNight },
      encoder: DEFAULTS.encoder.map((s) => ({ ...s })),
    };
    const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };

    function authorized(req) {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Digest ')) return false;
      const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
      if (f.username !== ctx.username) return false;
      const ha1 = md5(`${ctx.username}:${REALM}:${ctx.password}`);
      const ha2 = md5(`${req.method}:${f.uri}`);
      return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
        });
        req.on('error', reject);
      });
    }

    function send(res, status, payload) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    }

    return {
      onRequest(req, res) {
        if (!req.url.startsWith('/LAPI/V1.0/')) return false;
        if (!authorized(req)) {
          // Real firmware challenges with qop=auth and a per-boot nonce.
          res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${nonce}", qop="auth"` });
          res.end();
          return true;
        }

        const url = req.url;

        if (url === '/LAPI/V1.0/System/DeviceInfo' && req.method === 'GET') {
          count('DeviceInfo');
          send(res, 200, envelope({
            Manufacturer: 'Uniview',
            DeviceModel: 'IPC2322EBR5-DUPZ',
            FirmwareVersion: '2.800.0000000.0.R.210630',
          }));
          return true;
        }

        if (url === '/LAPI/V1.0/Channels' && req.method === 'GET') {
          count('Channels.get');
          send(res, 200, envelope([{ ChannelID: 1, ChannelName: 'Camera 1' }]));
          return true;
        }

        if (url === '/LAPI/V1.0/Channels/1/Image/Basic') {
          if (req.method === 'GET') {
            count('Image.Basic.get');
            send(res, 200, envelope({ ...state.basic }));
            return true;
          }
          if (req.method === 'PUT') {
            count('Image.Basic.put');
            readBody(req).then((body) => {
              // LAPI rejects with ResponseCode != 0 on HTTP 200 rather than a
              // 4xx — the adapter must read the envelope, not the status.
              if (ctx.mode === 'reject') {
                send(res, 200, JSON.stringify({ Response: { ResponseCode: 1, StatusString: 'Invalid param', Data: null } }));
                return;
              }
              // 'ignore' acknowledges but stores nothing: the ONVIF-stub
              // signature the conformance suite looks for.
              if (ctx.mode !== 'ignore') Object.assign(state.basic, body);
              send(res, 200, envelope(undefined, { ResponseURL: url }));
            }).catch(() => send(res, 400, JSON.stringify({ Response: { ResponseCode: 2, StatusString: 'Bad request', Data: null } })));
            return true;
          }
          return false;
        }

        if (url === '/LAPI/V1.0/Channels/1/Image/DayNight') {
          if (req.method === 'GET') {
            count('Image.DayNight.get');
            send(res, 200, envelope({ ...state.dayNight }));
            return true;
          }
          if (req.method === 'PUT') {
            count('Image.DayNight.put');
            readBody(req).then((body) => {
              if (ctx.mode !== 'ignore') Object.assign(state.dayNight, body);
              send(res, 200, envelope(undefined, { ResponseURL: url }));
            }).catch(() => send(res, 400, JSON.stringify({ Response: { ResponseCode: 2, StatusString: 'Bad request', Data: null } })));
            return true;
          }
          return false;
        }

        if (url === '/LAPI/V1.0/Channels/1/Media/VideoEncoder') {
          if (req.method === 'GET') {
            count('VideoEncoder.get');
            send(res, 200, envelope(state.encoder.map((s) => ({ ...s }))));
            return true;
          }
          if (req.method === 'PUT') {
            count('VideoEncoder.put');
            readBody(req).then((body) => {
              // The device requires the whole stream array in the PUT; a
              // partial object is a protocol error on real firmware.
              if (!Array.isArray(body)) {
                send(res, 400, JSON.stringify({ Response: { ResponseCode: 2, StatusString: 'Bad request', Data: null } }));
                return;
              }
              if (ctx.mode !== 'ignore') state.encoder = body.map((s) => ({ ...s }));
              send(res, 200, envelope(undefined, { ResponseURL: url }));
            }).catch(() => send(res, 400, JSON.stringify({ Response: { ResponseCode: 2, StatusString: 'Bad request', Data: null } })));
            return true;
          }
          return false;
        }

        return false;
      },
    };
  },
};
