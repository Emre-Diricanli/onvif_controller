/**
 * Reolink RLC-810A camera persona (ADAPTERS.md §8): the token-based JSON CGI
 * API every Reolink device exposes at /cgi-bin/api.cgi. Strict where the
 * firmware is strict: JSON-array bodies in and out, the token travels in the
 * query string, and SetEnc wants the whole Enc object. Details marked
 * "assumed from vendor docs, not hardware-verified" follow the vendor docs;
 * the rest matches observed Reolink behaviour.
 */
import { randomBytes } from 'node:crypto';

export const persona = {
  name: 'reolink-rlc810',
  vendor: 'reolink',
  create(ctx) {
    const tokens = new Set();
    // 'expire' mode: after the first successful GetImage/SetImage following a
    // login, the firmware invalidates the session token once, so the NEXT
    // request gets "please login!" — exercises transparent re-login.
    let expireArmed = false;

    const image = { channel: 0, bright: 128, contrast: 128, saturation: 128, sharpen: 128, hue: 128 };
    const isp = { channel: 0, dayNight: 'Auto', mirroring: false, rotation: false };
    const enc = {
      channel: 0,
      mainStream: { size: '2560*1440', frameRate: 25, bitRate: 6144, gop: 100, vType: 'h264' },
      subStream: { size: '640*360', frameRate: 15, bitRate: 512, gop: 100, vType: 'h264' },
    };
    const devInfo = { type: 'rlc810', model: 'RLC-810A', firmVersion: 'v3.1.0.956_22041500' };
    const status = [{ channel: 0, online: true, name: 'Camera 1', type: 'IPC' }];

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
              // rspCode -111 assumed from vendor docs, not hardware-verified.
              send(res, fail('Login', -111, 'login failed'));
            }
            return;
          }

          if (!token || !tokens.has(token)) {
            send(res, fail(cmd, -6, 'please login!'));
            return;
          }

          switch (cmd) {
            case 'GetImage':
              count('GetImage');
              armExpire(token);
              send(res, ok('GetImage', { Image: clone(image) }));
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
              if (ctx.mode !== 'ignore') Object.assign(image, next);
              send(res, ok('SetImage'));
              return;
            }
            case 'GetIsp':
              count('GetIsp');
              send(res, ok('GetIsp', { Isp: clone(isp) }));
              return;
            case 'SetIsp': {
              count('SetIsp');
              const next = msg.param?.Isp;
              if (!next || typeof next !== 'object') {
                send(res, fail('SetIsp', 400, 'invalid param'));
                return;
              }
              if (ctx.mode !== 'ignore') Object.assign(isp, next);
              send(res, ok('SetIsp'));
              return;
            }
            case 'GetEnc':
              count('GetEnc');
              send(res, ok('GetEnc', { Enc: clone(enc) }));
              return;
            case 'SetEnc': {
              count('SetEnc');
              const next = msg.param?.Enc;
              if (!next || typeof next !== 'object') {
                send(res, fail('SetEnc', 400, 'invalid param'));
                return;
              }
              if (ctx.mode !== 'ignore') Object.assign(enc, next);
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
