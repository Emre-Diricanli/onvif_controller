/**
 * Reolink RLN8-410 NVR persona (ADAPTERS.md §8): the same token-based JSON
 * CGI API as the cameras, over 4 channels. Channel state is deliberately
 * distinct per channel (image fields step by 10 per channel, encoder bitrates
 * step by 1024) so a write that leaks across channels is detectable in tests.
 * The token mechanics, body shapes and error shapes match the camera persona.
 */
import { randomBytes } from 'node:crypto';

const CHANNELS = 4;

export const persona = {
  name: 'reolink-nvr',
  vendor: 'reolink',
  create(ctx) {
    const tokens = new Set();
    let expireArmed = false;

    // Per-channel native objects; channel n gets distinct defaults.
    const image = Array.from({ length: CHANNELS }, (_, n) => ({
      channel: n,
      bright: 100 + n * 10,
      contrast: 110 + n * 10,
      saturation: 120 + n * 10,
      sharpen: 130 + n * 10,
      hue: 140 + n * 10,
    }));
    const isp = Array.from({ length: CHANNELS }, (_, n) => ({
      channel: n,
      dayNight: 'Auto',
      mirroring: false,
      rotation: false,
    }));
    const enc = Array.from({ length: CHANNELS }, (_, n) => ({
      channel: n,
      mainStream: { size: '2560*1440', frameRate: 25, bitRate: 4096 + n * 1024, gop: 100, vType: 'h264' },
      subStream: { size: '640*360', frameRate: 15, bitRate: 512 + n * 128, gop: 100, vType: 'h264' },
    }));
    const devInfo = { type: 'nvr', model: 'RLN8-410', firmVersion: 'v3.0.0.148_21112908' };
    const status = [
      { channel: 0, online: true, name: 'Front door', type: 'IPC' },
      { channel: 1, online: true, name: 'Garage', type: 'IPC' },
      { channel: 2, online: true, name: 'Garden', type: 'IPC' },
      { channel: 3, online: false, name: 'Side gate', type: 'IPC' },
    ];

    const count = (k) => { ctx.callCounts[k] = (ctx.callCounts[k] ?? 0) + 1; };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const send = (res, body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const ok = (cmd, value) => [{ cmd, code: 0, ...(value ? { value } : {}) }];
    const fail = (cmd, rspCode, detail) => [{ cmd, code: 1, error: { rspCode, detail } }];

    const armExpire = (token) => {
      if (ctx.mode === 'expire' && expireArmed) {
        expireArmed = false;
        tokens.delete(token);
      }
    };

    // Native channel number from the request: Get* sends {channel:n}, Set*
    // wraps the object ({Image:{channel:n,...}}).
    const channelOf = (msg) => {
      const p = msg.param ?? {};
      const n = Number(p.channel ?? p.Image?.channel ?? p.Isp?.channel ?? p.Enc?.channel ?? 0);
      return Number.isInteger(n) && n >= 0 && n < CHANNELS ? n : null;
    };

    return {
      onRequest(req, res) {
        if (!req.url.startsWith('/cgi-bin/api.cgi')) return false;
        const url = new URL(req.url, 'http://localhost');
        const cmd = url.searchParams.get('cmd');
        const token = url.searchParams.get('token');
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let msgs;
          try {
            msgs = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            res.writeHead(400);
            res.end('bad request');
            return;
          }
          const msg = Array.isArray(msgs) ? msgs[0] : null;
          if (!cmd || !msg || msg.cmd !== cmd) {
            send(res, fail(cmd ?? '?', -1, 'malformed request'));
            return;
          }

          if (cmd === 'Login') {
            count('Login');
            const cred = msg.param?.User ?? {};
            if (cred.userName === ctx.username && cred.password === ctx.password) {
              const name = `tok-${randomBytes(8).toString('hex')}`;
              tokens.add(name);
              expireArmed = ctx.mode === 'expire';
              send(res, ok('Login', { Token: { leaseTime: 3600, name } }));
            } else {
              send(res, fail('Login', -111, 'login failed'));
            }
            return;
          }

          if (!token || !tokens.has(token)) {
            send(res, fail(cmd, -6, 'please login!'));
            return;
          }

          const n = channelOf(msg);
          if (n === null) {
            send(res, fail(cmd, 400, 'invalid channel'));
            return;
          }

          switch (cmd) {
            case 'GetImage':
              count('GetImage');
              armExpire(token);
              send(res, ok('GetImage', { Image: clone(image[n]) }));
              return;
            case 'SetImage': {
              count('SetImage');
              const next = msg.param?.Image;
              if (!next || typeof next !== 'object') {
                send(res, fail('SetImage', 400, 'invalid param'));
                return;
              }
              if (ctx.mode === 'reject') {
                send(res, fail('SetImage', 400, 'invalid param'));
                return;
              }
              armExpire(token);
              if (ctx.mode !== 'ignore') Object.assign(image[n], next);
              send(res, ok('SetImage'));
              return;
            }
            case 'GetIsp':
              count('GetIsp');
              send(res, ok('GetIsp', { Isp: clone(isp[n]) }));
              return;
            case 'SetIsp': {
              count('SetIsp');
              const next = msg.param?.Isp;
              if (!next || typeof next !== 'object') {
                send(res, fail('SetIsp', 400, 'invalid param'));
                return;
              }
              if (ctx.mode !== 'ignore') Object.assign(isp[n], next);
              send(res, ok('SetIsp'));
              return;
            }
            case 'GetEnc':
              count('GetEnc');
              send(res, ok('GetEnc', { Enc: clone(enc[n]) }));
              return;
            case 'SetEnc': {
              count('SetEnc');
              const next = msg.param?.Enc;
              if (!next || typeof next !== 'object') {
                send(res, fail('SetEnc', 400, 'invalid param'));
                return;
              }
              if (ctx.mode !== 'ignore') Object.assign(enc[n], next);
              send(res, ok('SetEnc'));
              return;
            }
            case 'GetDevInfo':
              count('GetDevInfo');
              send(res, ok('GetDevInfo', { DevInfo: clone(devInfo) }));
              return;
            case 'GetChannelstatus':
              count('GetChannelstatus');
              send(res, ok('GetChannelstatus', { status: clone(status) }));
              return;
            default:
              send(res, fail(cmd, -1, 'unsupported command'));
              return;
          }
        });
        return true;
      },
    };
  },
};
