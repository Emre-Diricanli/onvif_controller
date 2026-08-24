/**
 * A mock of the Vatilon "Sinis 5MP IPC" proprietary CGI, for developing and
 * testing the vendor driver without the real camera.
 *
 * Fidelity to VENDOR.md is the whole job. This mock is strict exactly where
 * the real device is strict:
 *   - login is a HAND-ROLLED digest (hardcoded realm/nonce/qop/nc, and HA2
 *     computed over "/cgi-bin/web.cgi?mod=account&cmd=check" — NOT the URI
 *     being requested), so a correct STANDARD digest is rejected;
 *   - the session arrives in a Session-Id RESPONSE header and every later
 *     request must carry it as a request header;
 *   - writes must send TWO params (param = {channel}, param2 = the COMPLETE
 *     image object) or the answer is the bare text "param num error" with a
 *     200 status;
 *   - unrecognized modules answer the bare text "unknown error happened",
 *     also with a 200 status.
 *
 *   node tools/mock-vendor-camera.js [port]
 *
 * Credentials: any username with password "admin" (MOCK_VENDOR_PASSWORD
 * overrides). Modes via MOCK_VENDOR_MODE, following the MOCK_IMAGING_MODE
 * precedent in tools/mock-camera.js:
 *   default  writes are honoured and read back
 *   ignore   writes return ok and change nothing — catches a driver that
 *            trusts the HTTP status instead of reading back
 *   expire   each session dies after the first authenticated request,
 *            forcing the driver's re-login path
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv[2] ?? 10202);
const HOST = '127.0.0.1';
const MODE = process.env.MOCK_VENDOR_MODE ?? 'default';
const PASSWORD = process.env.MOCK_VENDOR_PASSWORD ?? 'admin';

// Frozen protocol constants (VENDOR.md section 1). Do not "improve" these.
const REALM = 'CAMERA';
const NONCE = 'b6ef824ee4090bbd124a4ccb39c5333a'; // hardcoded in the login page
const QOP = 'auth';
const NC = '00000001';
// HA2 covers THIS uri, never the one actually being requested. That mismatch
// is what makes a standard digest implementation fail against the real device.
const DIGEST_URI = '/cgi-bin/web.cgi?mod=account&cmd=check';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// VENDOR.md section 3: flat object, scalars 0..255 defaulting to 128, plus
// the nested day_begin / day_end objects.
const IMAGE_DEFAULTS = {
  brightness: 128,
  contrast: 128,
  saturation: 128,
  sharpness: 128,
  exposure: 128,
  day_night_mode: 128,
  wdr_enable: 128,
  mirror: 128,
  flip: 128,
  rotation: 128,
  nr_enable: 128,
  mwb_red: 128,
  mwb_blue: 128,
  mwb_green: 128,
  day_begin: { hour: 6, minute: 0 },
  day_end: { hour: 18, minute: 0 },
};
const IMAGE_KEYS = Object.keys(IMAGE_DEFAULTS);

let image = structuredClone(IMAGE_DEFAULTS);
const sessions = new Map(); // token -> { user, used }

/** Per-route call counts, so tests can assert what the camera actually received. */
const callCounts = Object.create(null);
const count = (name) => { callCounts[name] = (callCounts[name] ?? 0) + 1; };

function parseDigestFields(header) {
  const out = {};
  for (const m of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

/** The device recomputes the response from its own constants, not the client's. */
function expectedResponse(username, cnonce) {
  const ha1 = md5(`${username}:${REALM}:${PASSWORD}`);
  const ha2 = md5(`GET:${DIGEST_URI}`);
  return md5(`${ha1}:${NONCE}:${NC}:${cnonce}:${QOP}:${ha2}`);
}

/** Error strings are bare text with a 200 status, never JSON (VENDOR.md §5). */
function bareText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(text);
}

function okJson(res, extraHeaders = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ status: 'ok', data: '' }));
}

function handleLogin(req, res) {
  const challenge = `Digest realm="${REALM}", nonce="${NONCE}", qop="${QOP}"`;
  const reject = () => {
    count('rejected.digest');
    res.writeHead(401, { 'WWW-Authenticate': challenge, 'Content-Type': 'text/plain' });
    res.end('unknown error happened');
  };

  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Digest ')) return reject();
  const fields = parseDigestFields(header.slice('Digest '.length));
  const { username, realm, nonce, qop, nc, cnonce, response } = fields;
  if (!username || !cnonce || !response) return reject();
  if (realm !== REALM || nonce !== NONCE || qop !== QOP || nc !== NC) return reject();
  // A correct STANDARD digest computes HA2 over the request uri and lands a
  // different response — rejected here exactly as on the hardware.
  if (response !== expectedResponse(username, cnonce)) return reject();

  const token = crypto.randomBytes(16).toString('hex');
  sessions.set(token, { user: username, used: 0 });
  count('session.login1');
  okJson(res, { 'Session-Id': token });
}

function isCompleteImageObject(param2) {
  if (typeof param2 !== 'object' || param2 === null || Array.isArray(param2)) return false;
  const keys = Object.keys(param2);
  if (keys.length !== IMAGE_KEYS.length || !IMAGE_KEYS.every((k) => k in param2)) return false;
  for (const k of ['day_begin', 'day_end']) {
    if (typeof param2[k] !== 'object' || param2[k] === null) return false;
  }
  return true;
}

function handleSet(payload, res) {
  // The CGI counts parameters. Anything but exactly two — one param, a param2
  // carrying only the changed field, a form-encoded body — is "param num error".
  const paramKeys = payload && typeof payload === 'object'
    ? Object.keys(payload).filter((k) => /^param\d*$/.test(k))
    : [];
  const valid = payload && typeof payload === 'object'
    && payload.mod === 'image' && payload.cmd === 'set'
    && paramKeys.length === 2
    && typeof payload.param === 'object' && payload.param !== null
    && typeof payload.param.channel === 'number'
    && isCompleteImageObject(payload.param2);

  if (!valid) {
    count('image.set.paramNumError');
    bareText(res, 'param num error');
    return;
  }
  count('image.set');
  if (MODE !== 'ignore') {
    image = structuredClone(payload.param2);
  }
  okJson(res);
}

const server = http.createServer((req, res) => {
  // Test introspection endpoints, same convention as tools/mock-camera.js.
  if (req.method === 'GET' && req.url.startsWith('/__calls')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(callCounts));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/__reset')) {
    for (const k of Object.keys(callCounts)) delete callCounts[k];
    image = structuredClone(IMAGE_DEFAULTS);
    res.writeHead(204).end();
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    // The one unauthenticated route.
    if (req.method === 'GET'
      && url.searchParams.get('mod') === 'session'
      && url.searchParams.get('cmd') === 'login1') {
      handleLogin(req, res);
      return;
    }

    // Every other request needs a live Session-Id request header.
    const token = req.headers['session-id'];
    const session = typeof token === 'string' ? sessions.get(token) : undefined;
    if (!session) {
      count('rejected.noSession');
      bareText(res, 'unknown error happened');
      return;
    }
    if (MODE === 'expire' && session.used >= 1) {
      sessions.delete(token);
      count('rejected.expired');
      bareText(res, 'unknown error happened');
      return;
    }
    session.used += 1;

    // POST bodies carry mod/cmd in the JSON; GETs carry them in the query.
    let payload = null;
    if (req.method === 'POST') {
      try { payload = JSON.parse(body); } catch { payload = null; }
      // A form-encoded (or otherwise non-JSON) body has no countable params.
      if (payload === null) {
        count('image.set.paramNumError');
        bareText(res, 'param num error');
        return;
      }
    }
    const mod = req.method === 'POST' ? payload?.mod : url.searchParams.get('mod');
    const cmd = req.method === 'POST' ? payload?.cmd : url.searchParams.get('cmd');

    if (mod === 'session' && cmd === 'heartbeat') {
      count('session.heartbeat');
      okJson(res);
      return;
    }
    if (req.method === 'GET' && mod === 'image' && cmd === 'get') {
      count('image.get');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(image));
      return;
    }
    if (req.method === 'POST' && mod === 'image' && cmd === 'set') {
      handleSet(payload, res);
      return;
    }

    count(`unknown.${mod ?? '?'}.${cmd ?? '?'}`);
    bareText(res, 'unknown error happened');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Vatilon CGI camera listening at http://${HOST}:${PORT}/cgi-bin/web.cgi`);
  console.log(`  Login with any username and password "${PASSWORD}" via the hand-rolled digest (see VENDOR.md).`);
  console.log(`  Vendor mode: ${MODE} (MOCK_VENDOR_MODE=ignore|expire).`);
  console.log('  Introspection: GET /__calls, POST /__reset.');
});
