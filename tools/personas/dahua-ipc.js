/**
 * Persona: Dahua IPC-HDW2431T-AS-S2 — a single-sensor Dahua camera speaking
 * the HTTP API (CGI) the Dahua adapter drives (tools/tests/dahua.mjs).
 *
 * Also exports createDahuaPersona(), the CGI engine shared with the Lorex
 * recorder persona (lorex-n864.js): the same firmware family answers the same
 * way, only the model, channel count and table contents differ.
 *
 * Behaviour encoded here:
 *   - Every /cgi-bin/ request needs RFC 2617 Digest with qop=auth (realm
 *     "Login to <serial>", an opaque value) for ctx.username/ctx.password;
 *     anything else gets 401 + challenge. Paths outside /cgi-bin/ fall
 *     through (the harness answers 404).
 *   - Answers are key=value lines with CRLF endings; getConfig prefixes
 *     every key with "table.".
 *   - setConfig is partial and atomic: every path must already exist and
 *     every value must validate, else the whole request is refused with
 *     HTTP 400 "Error\r\nBad Request!\r\n" and nothing changes.
 *   - An unknown CGI answers 404 with the same Error body; an unknown action
 *     or config name answers 400.
 * Shapes and refusal bodies are assumed from vendor docs, not
 * hardware-verified.
 *
 * Modes (ctx.mode):
 *   default: setConfig validates and lands; reads see it.
 *   ignore:  setConfig answers "OK" and changes nothing (the stub signature).
 *   reject:  setConfig answers 400 "Error" and changes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');
const CRLF = '\r\n';
const ERROR_BODY = `Error${CRLF}Bad Request!${CRLF}`;

const isInt = (v) => /^-?\d+$/.test(v);
const isNum = (v) => /^-?\d+(\.\d+)?$/.test(v);
const inRange = (lo, hi) => (v) => isInt(v) && Number(v) >= lo && Number(v) <= hi;

/**
 * Value validation by leaf name — the parts real firmware is strict about.
 * A leaf not listed here accepts any value of the same shape (int stays int).
 */
const VALIDATORS = {
  Brightness: inRange(0, 100),
  Contrast: inRange(0, 100),
  Saturation: inRange(0, 100),
  Hue: inRange(0, 100),
  Sharpness: inRange(0, 100),
  DayNightColor: inRange(0, 2),
  Mirror: (v) => v === 'true' || v === 'false',
  Flip: (v) => v === 'true' || v === 'false',
  Compression: (v) => ['H.264', 'H.265', 'MJPG'].includes(v),
  BitRateControl: (v) => v === 'CBR' || v === 'VBR',
  FPS: (v) => isNum(v) && Number(v) >= 1 && Number(v) <= 30,
  BitRate: (v) => isInt(v) && Number(v) >= 32 && Number(v) <= 16384,
  GOP: (v) => isInt(v) && Number(v) >= 1 && Number(v) <= 300,
  Width: (v) => isInt(v) && Number(v) > 0,
  Height: (v) => isInt(v) && Number(v) > 0,
};

/** Build the native tables for `channels`, using per-channel defaults from `defaults(ch)`. */
function buildTables(channels, defaults) {
  const store = new Map();
  for (let ch = 0; ch < channels; ch += 1) {
    const d = defaults(ch);
    store.set(`ChannelTitle[${ch}].Name`, d.title);
    // Three time-section profiles per channel, as the firmware keeps them;
    // only section 0 differs per channel so a write to the wrong section shows.
    for (let s = 0; s < 3; s += 1) {
      store.set(`VideoColor[${ch}][${s}].Brightness`, String(s === 0 ? d.brightness : 50));
      store.set(`VideoColor[${ch}][${s}].Contrast`, String(s === 0 ? d.contrast : 50));
      store.set(`VideoColor[${ch}][${s}].Hue`, '50');
      store.set(`VideoColor[${ch}][${s}].Saturation`, String(s === 0 ? d.saturation : 50));
      store.set(`VideoInSharpness[${ch}][${s}].Level`, '50');
      store.set(`VideoInSharpness[${ch}][${s}].Sharpness`, String(s === 0 ? d.sharpness : 50));
    }
    store.set(`VideoInOptions[${ch}].DayNightColor`, '1');
    store.set(`VideoInOptions[${ch}].Flip`, 'false');
    store.set(`VideoInOptions[${ch}].Mirror`, 'false');
    store.set(`VideoInOptions[${ch}].Rotate90`, '0');
    for (const [fmt, enc] of [['MainFormat', d.main], ['ExtraFormat', d.sub]]) {
      const p = `Encode[${ch}].${fmt}[0]`;
      store.set(`${p}.AudioEnable`, 'false');
      store.set(`${p}.Video.BitRate`, String(enc.bitrate));
      store.set(`${p}.Video.BitRateControl`, enc.rateControl);
      store.set(`${p}.Video.Compression`, enc.codec);
      store.set(`${p}.Video.FPS`, String(enc.fps));
      store.set(`${p}.Video.GOP`, String(enc.gop));
      store.set(`${p}.Video.Height`, String(enc.height));
      store.set(`${p}.Video.Profile`, 'Main');
      store.set(`${p}.Video.Quality`, '4');
      store.set(`${p}.Video.Width`, String(enc.width));
      store.set(`${p}.VideoEnable`, 'true');
    }
  }
  return store;
}

/**
 * The shared Dahua CGI engine.
 *   info:     { deviceType, version, serial, vendor? }   (vendor -> getVendor)
 *   product:  { [key]: value } lines for getProductDefinition
 *   channels: number of channels
 *   defaults: (ch) => { title, brightness, contrast, saturation, sharpness, main, sub }
 */
export function createDahuaPersona({ name, info, product, channels, defaults }) {
  return {
    name,
    vendor: 'dahua',
    create(ctx) {
      const realm = `Login to ${info.serial}`;
      const nonce = randomBytes(12).toString('hex');
      const opaque = randomBytes(8).toString('hex');
      const store = buildTables(channels, defaults);
      const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };

      // RFC 2617 qop=auth verification, same construction as the harness
      // self-test. The password is only used inside HA1 — never echoed.
      function authorized(req) {
        const h = req.headers.authorization ?? '';
        if (!h.startsWith('Digest ')) return false;
        const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
        if (f.username !== ctx.username || f.realm !== realm || f.nonce !== nonce) return false;
        if (f.qop !== 'auth' || !f.nc || !f.cnonce || f.opaque !== opaque) return false;
        const ha1 = md5(`${ctx.username}:${realm}:${ctx.password}`);
        const ha2 = md5(`${req.method}:${f.uri}`);
        return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
      }

      const send = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'text/plain;charset=utf-8' });
        res.end(body);
      };
      const lines = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join(CRLF) + CRLF;

      function magicBox(url, res) {
        const action = url.searchParams.get('action');
        count(`magicBox.${action}`);
        switch (action) {
          case 'getDeviceType': return send(res, 200, lines([['type', info.deviceType]]));
          case 'getSoftwareVersion': return send(res, 200, lines([['version', info.version]]));
          case 'getSerialNo': return send(res, 200, lines([['sn', info.serial]]));
          case 'getVendor':
            if (!info.vendor) return send(res, 400, ERROR_BODY);
            return send(res, 200, lines([['vendor', info.vendor]]));
          case 'getProductDefinition':
            return send(res, 200, lines(Object.entries(product).map(([k, v]) => [`table.${k}`, v])));
          default: return send(res, 400, ERROR_BODY);
        }
      }

      function getConfig(url, res) {
        const table = url.searchParams.get('name') ?? '';
        count(`getConfig.${table}`);
        const pairs = [...store].filter(([k]) => k.startsWith(`${table}[`)).map(([k, v]) => [`table.${k}`, v]);
        if (!table || pairs.length === 0) return send(res, 400, ERROR_BODY);
        return send(res, 200, lines(pairs));
      }

      function setConfig(url, res) {
        count('setConfig');
        const updates = [...url.searchParams].filter(([k]) => k !== 'action');
        if (updates.length === 0 || ctx.mode === 'reject') return send(res, 400, ERROR_BODY);
        // Atomic: one unknown path or bad value refuses the whole request.
        for (const [path, value] of updates) {
          if (!store.has(path)) return send(res, 400, ERROR_BODY);
          const leaf = path.slice(path.lastIndexOf('.') + 1);
          const valid = VALIDATORS[leaf] ?? ((v) => !isInt(store.get(path)) || isInt(v));
          if (!valid(value)) return send(res, 400, ERROR_BODY);
        }
        if (ctx.mode !== 'ignore') for (const [path, value] of updates) store.set(path, value);
        return send(res, 200, `OK${CRLF}`);
      }

      return {
        onRequest(req, res) {
          const url = new URL(req.url, 'http://persona');
          if (!url.pathname.startsWith('/cgi-bin/')) return false;
          if (!authorized(req)) {
            count('401');
            res.writeHead(401, {
              'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="${opaque}"`,
              'Content-Type': 'text/plain',
            });
            res.end(`Error${CRLF}Unauthorized!${CRLF}`);
            return true;
          }
          req.resume();
          if (req.method !== 'GET') { send(res, 400, ERROR_BODY); return true; }
          if (url.pathname === '/cgi-bin/magicBox.cgi') { magicBox(url, res); return true; }
          if (url.pathname === '/cgi-bin/configManager.cgi') {
            const action = url.searchParams.get('action');
            if (action === 'getConfig') getConfig(url, res);
            else if (action === 'setConfig') setConfig(url, res);
            else send(res, 400, ERROR_BODY);
            return true;
          }
          count('unknown');
          send(res, 404, ERROR_BODY);
          return true;
        },
      };
    },
  };
}

export const persona = createDahuaPersona({
  name: 'dahua-ipc',
  info: {
    deviceType: 'IPC-HDW2431T-AS-S2',
    version: '2.800.0000000.25.R,build:2020-07-15',
    serial: '6J0A4E2PAZ1F3C7',
    vendor: 'Dahua',
  },
  product: { VideoInputChannels: '1', MaxRemoteInputChannels: '0', MaxExtraStream: '1' },
  channels: 1,
  defaults: () => ({
    title: 'IPC',
    brightness: 50,
    contrast: 50,
    saturation: 50,
    sharpness: 50,
    main: { codec: 'H.265', width: 2688, height: 1520, fps: 20, bitrate: 4096, rateControl: 'VBR', gop: 40 },
    sub: { codec: 'H.264', width: 704, height: 480, fps: 15, bitrate: 512, rateControl: 'CBR', gop: 30 },
  }),
});
