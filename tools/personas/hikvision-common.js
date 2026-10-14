/**
 * Shared ISAPI device model for the Hikvision personas (hikvision-ds2cd,
 * hikvision-nvr). Not a persona itself — it exports no `persona`, so the
 * registry skips it.
 *
 * Strict where the real firmware is strict (ADAPTERS.md §8):
 *   - HTTP Digest (RFC 2617, qop=auth) on every request; anything else is 401;
 *   - PUT replaces the node: a body missing the root element is
 *     400 invalidContent, an out-of-range level or an unsupported codec /
 *     resolution / frame rate is 400 badParameters, both as <ResponseStatus>;
 *   - an unknown URL is 404 <ResponseStatus> notSupport.
 * This module parses requests with its own tiny regexes, deliberately NOT the
 * adapter's XML helper, so an adapter bug cannot be mirrored by the mock.
 *
 * Modes (ctx.mode): default (writes land), ignore (PUT answers OK and changes
 * nothing — the stub signature), reject (every PUT is 400 badParameters).
 * Element names follow the published ISAPI schema — assumed from vendor docs,
 * not hardware-verified.
 */
import { createHash, randomBytes } from 'node:crypto';

const NS = 'http://www.hikvision.com/ver20/XMLSchema';
const md5 = (s) => createHash('md5').update(s).digest('hex');
const tag = (body, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(body);
  return m ? m[1].trim() : null;
};

const RESOLUTIONS = {
  1: [[2560, 1440], [1920, 1080], [1280, 720]],
  2: [[640, 360], [704, 576], [640, 480]],
};
const FRAME_RATES = { 1: [2500, 2000, 1500, 1000, 500, 100], 2: [1500, 1000, 500, 100] };
const BITRATE = { 1: [256, 16384], 2: [32, 2048] };

function status(res, http, code, statusString, subStatusCode) {
  res.writeHead(http, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="2.0" xmlns="${NS}">`
    + `<requestURL></requestURL><statusCode>${code}</statusCode><statusString>${statusString}</statusString>`
    + `<subStatusCode>${subStatusCode}</subStatusCode></ResponseStatus>`);
  return true;
}

const ok = (res) => status(res, 200, 1, 'OK', 'ok');
const bad = (res, sub = 'badParameters') => status(res, 400, 4, 'Invalid Operation', sub);
const notSupported = (res) => status(res, 404, 4, 'Invalid Operation', 'notSupport');

function xmlReply(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  return true;
}

/**
 * @param {object} spec  { name, model, deviceType, channels, recorder, defaults(n) }
 */
export function hikvisionPersona(spec) {
  return {
    name: spec.name,
    vendor: 'hikvision',
    create(ctx) {
      const realm = spec.model;
      const nonce = randomBytes(8).toString('hex');
      const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };
      const mode = ctx.mode ?? 'default';

      const image = new Map();
      const streams = new Map();
      for (let n = 1; n <= spec.channels; n += 1) {
        const d = spec.defaults(n);
        image.set(n, {
          brightness: d.brightness, contrast: 50, saturation: 50, sharpness: 50,
          ircut: 'auto', wdrMode: 'close', wdrLevel: 50, blc: false, flipEnabled: false, flipStyle: 'LEFTRIGHT',
        });
        streams.set(n * 100 + 1, { codec: 'H.265', width: 2560, height: 1440, fps: 2500, mode: 'VBR', cbr: 4096, vbr: 4096, gop: 50 });
        streams.set(n * 100 + 2, { codec: 'H.264', width: 640, height: 360, fps: 1500, mode: 'CBR', cbr: 512, vbr: 512, gop: 30 });
      }

      function authorized(req) {
        const h = req.headers.authorization ?? '';
        if (!h.startsWith('Digest ')) return false;
        const f = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
        if (f.username !== ctx.username || f.qop !== 'auth') return false;
        const ha1 = md5(`${ctx.username}:${realm}:${ctx.password}`);
        const ha2 = md5(`${req.method}:${f.uri}`);
        return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
      }

      const deviceInfo = () => `<DeviceInfo version="2.0" xmlns="${NS}"><deviceName>${spec.name}</deviceName>`
        + `<deviceID>persona</deviceID><model>${spec.model}</model><serialNumber>${spec.model}20260101AAWR000000</serialNumber>`
        + `<firmwareVersion>V5.7.3</firmwareVersion><firmwareReleasedDate>build 230712</firmwareReleasedDate>`
        + `<deviceType>${spec.deviceType}</deviceType></DeviceInfo>`;

      const streamXml = (id, s) => `<StreamingChannel version="2.0" xmlns="${NS}"><id>${id}</id>`
        + `<channelName>Camera ${String(Math.floor(id / 100)).padStart(2, '0')}</channelName><enabled>true</enabled>`
        + '<Transport><ControlProtocolList><ControlProtocol><streamingTransport>RTSP</streamingTransport></ControlProtocol></ControlProtocolList></Transport>'
        + `<Video><enabled>true</enabled><videoInputChannelID>${Math.floor(id / 100)}</videoInputChannelID>`
        + `<videoCodecType>${s.codec}</videoCodecType><videoScanType>progressive</videoScanType>`
        + `<videoResolutionWidth>${s.width}</videoResolutionWidth><videoResolutionHeight>${s.height}</videoResolutionHeight>`
        + `<videoQualityControlType>${s.mode}</videoQualityControlType><constantBitRate>${s.cbr}</constantBitRate>`
        + `<fixedQuality>60</fixedQuality><vbrUpperCap>${s.vbr}</vbrUpperCap><maxFrameRate>${s.fps}</maxFrameRate>`
        + `<GovLength>${s.gop}</GovLength></Video></StreamingChannel>`;

      const capsXml = (id) => {
        const kind = id % 100;
        const [lo, hi] = BITRATE[kind];
        return `<StreamingChannel version="2.0" xmlns="${NS}"><id>${id}</id><Video>`
          + '<videoCodecType opt="H.264,H.265,MJPEG">H.264</videoCodecType>'
          + `<videoResolutionWidth opt="${RESOLUTIONS[kind].map(([w]) => w).join(',')}">0</videoResolutionWidth>`
          + `<videoResolutionHeight opt="${RESOLUTIONS[kind].map(([, h]) => h).join(',')}">0</videoResolutionHeight>`
          + '<videoQualityControlType opt="CBR,VBR">CBR</videoQualityControlType>'
          + `<constantBitRate min="${lo}" max="${hi}">0</constantBitRate><vbrUpperCap min="${lo}" max="${hi}">0</vbrUpperCap>`
          + `<maxFrameRate opt="${FRAME_RATES[kind].join(',')}">0</maxFrameRate>`
          + '<GovLength min="1" max="400">0</GovLength></Video></StreamingChannel>';
      };

      const imageXml = {
        color: (s) => `<Color version="2.0" xmlns="${NS}"><brightnessLevel>${s.brightness}</brightnessLevel>`
          + `<contrastLevel>${s.contrast}</contrastLevel><saturationLevel>${s.saturation}</saturationLevel></Color>`,
        sharpness: (s) => `<Sharpness version="2.0" xmlns="${NS}"><SharpnessLevel>${s.sharpness}</SharpnessLevel></Sharpness>`,
        ircutFilter: (s) => `<IrcutFilter version="2.0" xmlns="${NS}"><IrcutFilterType>${s.ircut}</IrcutFilterType>`
          + '<nightToDayFilterLevel>4</nightToDayFilterLevel></IrcutFilter>',
        WDR: (s) => `<WDR version="2.0" xmlns="${NS}"><mode>${s.wdrMode}</mode><WDRLevel>${s.wdrLevel}</WDRLevel></WDR>`,
        BLC: (s) => `<BLC version="2.0" xmlns="${NS}"><enabled>${s.blc}</enabled><BLCMode>CENTER</BLCMode></BLC>`,
        imageFlip: (s) => `<ImageFlip version="2.0" xmlns="${NS}"><enabled>${s.flipEnabled}</enabled>`
          + `<ImageFlipStyle>${s.flipStyle}</ImageFlipStyle></ImageFlip>`,
      };

      const levelOk = (v) => v !== null && /^\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 100;

      /** Apply a PUT body to a copy of the image state, or return an error sub-code. */
      function applyImage(sub, body, s) {
        const next = { ...s };
        const root = { color: 'Color', sharpness: 'Sharpness', ircutFilter: 'IrcutFilter', WDR: 'WDR', BLC: 'BLC', imageFlip: 'ImageFlip' }[sub];
        if (!new RegExp(`<${root}[\\s>]`).test(body)) return { error: 'invalidContent' };
        if (sub === 'color') {
          for (const [k, t] of [['brightness', 'brightnessLevel'], ['contrast', 'contrastLevel'], ['saturation', 'saturationLevel']]) {
            const v = tag(body, t);
            if (v === null) return { error: 'invalidContent' };   // the whole node is required
            if (!levelOk(v)) return { error: 'badParameters' };
            next[k] = Number(v);
          }
        } else if (sub === 'sharpness') {
          const v = tag(body, 'SharpnessLevel');
          if (!levelOk(v)) return { error: 'badParameters' };
          next.sharpness = Number(v);
        } else if (sub === 'ircutFilter') {
          const v = tag(body, 'IrcutFilterType');
          if (!['auto', 'day', 'night'].includes(v)) return { error: 'badParameters' };
          next.ircut = v;
        } else if (sub === 'WDR') {
          const m = tag(body, 'mode');
          const l = tag(body, 'WDRLevel');
          if (!['open', 'close', 'auto'].includes(m) || (l !== null && !levelOk(l))) return { error: 'badParameters' };
          next.wdrMode = m;
          if (l !== null) next.wdrLevel = Number(l);
        } else if (sub === 'BLC') {
          const v = tag(body, 'enabled');
          if (!['true', 'false'].includes(v)) return { error: 'badParameters' };
          next.blc = v === 'true';
        } else if (sub === 'imageFlip') {
          const e = tag(body, 'enabled');
          const st = tag(body, 'ImageFlipStyle');
          if (!['true', 'false'].includes(e) || !['LEFTRIGHT', 'UPDOWN', 'CENTER'].includes(st)) return { error: 'badParameters' };
          next.flipEnabled = e === 'true';
          next.flipStyle = st;
        }
        return { next };
      }

      function applyStream(id, body, s) {
        if (!/<StreamingChannel[\s>]/.test(body) || !/<Video[\s>]/.test(body)) return { error: 'invalidContent' };
        const kind = id % 100;
        const next = {
          codec: tag(body, 'videoCodecType'),
          width: Number(tag(body, 'videoResolutionWidth')),
          height: Number(tag(body, 'videoResolutionHeight')),
          fps: Number(tag(body, 'maxFrameRate')),
          mode: tag(body, 'videoQualityControlType'),
          cbr: Number(tag(body, 'constantBitRate')),
          vbr: Number(tag(body, 'vbrUpperCap')),
          gop: Number(tag(body, 'GovLength')),
        };
        const [lo, hi] = BITRATE[kind];
        const valid = ['H.264', 'H.265', 'MJPEG'].includes(next.codec)
          && RESOLUTIONS[kind].some(([w, h]) => w === next.width && h === next.height)
          && FRAME_RATES[kind].includes(next.fps)
          && ['CBR', 'VBR'].includes(next.mode)
          && next.cbr >= lo && next.cbr <= hi && next.vbr >= lo && next.vbr <= hi
          && next.gop >= 1 && next.gop <= 400;
        return valid ? { next: { ...s, ...next } } : { error: 'badParameters' };
      }

      function readBody(req) {
        return new Promise((resolve) => {
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => resolve(body));
        });
      }

      return {
        onRequest(req, res) {
          if (!req.url.startsWith('/ISAPI/')) return false;
          if (!authorized(req)) {
            res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}", stale="FALSE"` });
            res.end();
            return true;
          }
          const url = req.url.split('?')[0];
          let m;

          if (req.method === 'GET' && url === '/ISAPI/System/deviceInfo') { count('deviceInfo'); return xmlReply(res, deviceInfo()); }

          if (req.method === 'GET' && url === '/ISAPI/System/Video/inputs/channels') {
            count('inputs');
            if (spec.recorder) return notSupported(res);
            return xmlReply(res, `<VideoInputChannelList version="2.0" xmlns="${NS}">`
              + `<VideoInputChannel><id>1</id><inputPort>1</inputPort><name>Camera 01</name></VideoInputChannel></VideoInputChannelList>`);
          }

          if (req.method === 'GET' && url === '/ISAPI/ContentMgmt/InputProxy/channels') {
            count('inputProxy');
            if (!spec.recorder) return notSupported(res);
            const items = [...image.keys()].map((n) => `<InputProxyChannel><id>${n}</id><name>${spec.channelName(n)}</name>`
              + `<sourceInputPortDescriptor><proxyProtocol>HIKVISION</proxyProtocol><ipAddress>192.168.254.${n + 1}</ipAddress></sourceInputPortDescriptor></InputProxyChannel>`).join('');
            return xmlReply(res, `<InputProxyChannelList version="2.0" xmlns="${NS}">${items}</InputProxyChannelList>`);
          }

          if (req.method === 'GET' && url === '/ISAPI/Streaming/channels') {
            count('streams');
            return xmlReply(res, `<StreamingChannelList version="2.0" xmlns="${NS}">`
              + [...streams].map(([id, s]) => streamXml(id, s)).join('') + '</StreamingChannelList>');
          }

          if ((m = /^\/ISAPI\/Streaming\/channels\/(\d+)\/capabilities$/.exec(url)) && req.method === 'GET') {
            const id = Number(m[1]);
            if (!streams.has(id)) return notSupported(res);
            count('stream.caps');
            return xmlReply(res, capsXml(id));
          }

          if ((m = /^\/ISAPI\/Streaming\/channels\/(\d+)$/.exec(url))) {
            const id = Number(m[1]);
            if (!streams.has(id)) return notSupported(res);
            if (req.method === 'GET') { count('stream.get'); return xmlReply(res, streamXml(id, streams.get(id))); }
            if (req.method === 'PUT') {
              count('stream.put');
              readBody(req).then((body) => {
                if (mode === 'reject') return bad(res);
                const { next, error } = applyStream(id, body, streams.get(id));
                if (error) return bad(res, error);
                if (mode !== 'ignore') streams.set(id, next);
                return ok(res);
              });
              return true;
            }
          }

          if ((m = /^\/ISAPI\/Image\/channels\/(\d+)\/(color|sharpness|ircutFilter|WDR|BLC|imageFlip)$/.exec(url))) {
            const n = Number(m[1]);
            const sub = m[2];
            if (!image.has(n)) return notSupported(res);
            if (req.method === 'GET') { count(`image.${sub}.get`); return xmlReply(res, imageXml[sub](image.get(n))); }
            if (req.method === 'PUT') {
              count(`image.${sub}.put`);
              readBody(req).then((body) => {
                if (mode === 'reject') return bad(res);
                const { next, error } = applyImage(sub, body, image.get(n));
                if (error) return bad(res, error);
                if (mode !== 'ignore') image.set(n, next);
                return ok(res);
              });
              return true;
            }
          }

          return notSupported(res);
        },
      };
    },
  };
}
