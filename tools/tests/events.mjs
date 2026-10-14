/**
 * ONVIF library crash-guard tests (server/onvif/events.js guardUnsubscribe).
 *
 * Production log: `TypeError: callback.call is not a function at
 * Cam.<anonymous> (node_modules/onvif/lib/events.js:309)`. The library defines
 * `unsubscribe(callback)` but its own pull loop calls `unsubscribe({}, cb)`,
 * so the library captures `{}` as the callback and throws ASYNCHRONOUSLY from
 * inside the HTTP response handler — where no caller try/catch can reach it.
 * These tests reproduce that crash against the REAL onvif Cam with a stubbed
 * `_request`, then prove the guard neutralizes it for every call shape, that
 * the callback fires exactly once, and that the audited methods (renew,
 * pullMessages) behave the same.
 *
 * Plain node, no ports, no network: `node tools/tests/events.mjs`.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import onvif from 'onvif';
import { guardUnsubscribe } from '../../server/onvif/events.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  uncaught.length = 0;
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}:`, err); }
}

/**
 * Anything that escapes to the top level lands here instead of killing the
 * process — that escape IS the production failure mode under test, so the
 * suite installs a handler for the whole run and asserts on what it catches.
 */
const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(err));
process.on('unhandledRejection', (err) => uncaught.push(err));

const SUB_ADDRESS = 'http://127.0.0.1:1/onvif/subscription';

/** A real Cam (autoconnect off, _request stubbed) with a live subscription. */
function makeCam({ withSubscription = true, responder = null } = {}) {
  const cam = new onvif.Cam({
    hostname: '127.0.0.1', port: 1, username: 'u', password: 'p', autoconnect: false,
  });
  if (withSubscription) {
    // The library reads .href off the address (its _parseUrl output is a
    // parsed-URL object) and .referenceParameters in a try/catch.
    cam.events.subscription = { subscriptionReference: { address: new URL(SUB_ADDRESS) } };
    cam.events.terminationTime = new Date(Date.now() + 120_000);
  }
  const requests = [];
  cam._request = (options, cb) => {
    requests.push(options);
    setImmediate(() => cb(null, responder ? responder(options) : { unsubscribeResponse: [{}] }, '<xml/>'));
  };
  return { cam, requests };
}

/** A spy that records invocations so "exactly once" is checkable. */
function spy() {
  const fn = (...args) => { fn.calls.push(args); };
  fn.calls = [];
  return fn;
}

// --------------------------------------------------------------------------
console.log('\nReproduce the production crash WITHOUT the guard');

await test('unsubscribe({}, cb) really does throw callback.call asynchronously', async () => {
  const { cam, requests } = makeCam();
  const cb = spy();
  cam.unsubscribe({}, cb); // the library's own error-path call shape (events.js ~385)
  assert.equal(requests.length, 1, 'the Unsubscribe request should have gone out');
  await delay(30);
  assert.equal(cb.calls.length, 0, 'the real callback is never reached');
  assert.equal(uncaught.length, 1, `expected exactly one uncaught error, got ${uncaught.length}`);
  const err = uncaught[0];
  assert.match(String(err?.message), /callback\.call is not a function/);
  assert.match(String(err?.stack ?? ''), /events\.js/, 'the throw must come from the onvif library itself');
});

await test('renew(cb) really does throw on the missing callback', async () => {
  const { cam } = makeCam({ responder: () => ({ renewResponse: [{ currentTime: '2026-01-01T00:00:00Z', terminationTime: '2026-01-01T00:02:00Z' }] }) });
  const cb = spy();
  cam.renew(cb); // function in the options slot — the library never sees a callback
  await delay(30);
  assert.equal(cb.calls.length, 0);
  assert.equal(uncaught.length, 1);
  assert.match(String(uncaught[0]?.message), /Cannot read properties of undefined \(reading 'call'\)/);
});

await test('pullMessages(cb) really does throw on the missing callback', async () => {
  const { cam } = makeCam({ responder: () => ({ pullMessagesResponse: [{ notificationMessage: [] }] }) });
  const cb = spy();
  cam.pullMessages(cb);
  await delay(30);
  assert.equal(cb.calls.length, 0);
  assert.equal(uncaught.length, 1);
  assert.match(String(uncaught[0]?.message), /Cannot read properties of undefined \(reading 'call'\)/);
});

// --------------------------------------------------------------------------
console.log('\nGuarded unsubscribe: all three call shapes');

for (const [shape, invoke] of [
  ['unsubscribe()', (cam, cb) => cam.unsubscribe()],
  ['unsubscribe(cb)', (cam, cb) => cam.unsubscribe(cb)],
  ['unsubscribe({}, cb)', (cam, cb) => cam.unsubscribe({}, cb)],
]) {
  await test(`${shape}: no uncaught exception, callback invoked exactly once`, async () => {
    const { cam, requests } = makeCam();
    guardUnsubscribe(cam);
    const cb = spy();
    invoke(cam, cb);
    await delay(30);
    assert.deepEqual(uncaught, [], `uncaught: ${uncaught.map((e) => e?.message)}`);
    assert.equal(requests.length, 1, 'the Unsubscribe SOAP request went out');
    assert.match(requests[0].body, /<Unsubscribe/, 'the body really is an Unsubscribe');
    if (shape === 'unsubscribe()') return; // no callback to count
    assert.equal(cb.calls.length, 1, `callback ran ${cb.calls.length} times`);
    assert.equal(cb.calls[0][0], null, 'a successful unsubscribe reports no error');
  });
}

await test('guard is idempotent: guarding twice does not double-invoke', async () => {
  const { cam, requests } = makeCam();
  guardUnsubscribe(cam);
  guardUnsubscribe(cam);
  const cb = spy();
  cam.unsubscribe({}, cb);
  await delay(30);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 1);
  assert.equal(cb.calls.length, 1);
});

await test('no subscription: fast path answers the callback without a request', async () => {
  const { cam, requests } = makeCam({ withSubscription: false });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.unsubscribe({}, cb); // pre-guard this threw SYNCHRONOUSLY ('pull-point subscription first!')
  cam.unsubscribe();        // and this shape threw too
  await delay(10);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 0, 'nothing to unsubscribe from, so nothing is sent');
  assert.equal(cb.calls.length, 1);
  assert.equal(cb.calls[0][0], null, 'an already-gone subscription is not an error');
});

await test('a synchronous throw inside the original is routed to the callback once', async () => {
  const { cam, requests } = makeCam();
  guardUnsubscribe(cam);
  cam._envelopeHeader = () => { throw new Error('envelope boom'); }; // force the original to throw
  const cb = spy();
  cam.unsubscribe({}, cb);
  await delay(10);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 0);
  assert.equal(cb.calls.length, 1);
  assert.match(String(cb.calls[0][0]?.message), /envelope boom/);
});

await test('a throwing callback is contained, not escaped', async () => {
  const { cam } = makeCam();
  guardUnsubscribe(cam);
  cam.unsubscribe({}, () => { throw new Error('callback boom'); });
  await delay(30);
  assert.deepEqual(uncaught, [], 'a listener throwing must not become an uncaught exception');
});

// --------------------------------------------------------------------------
console.log('\nAudited methods: renew(options, callback) and pullMessages(options, callback)');

const renewResponder = () => ({ renewResponse: [{ currentTime: '2026-01-01T00:00:00Z', terminationTime: '2026-01-01T00:02:00Z' }] });
const pullResponder = () => ({ pullMessagesResponse: [{ notificationMessage: [] }] });

await test('renew({}, cb): callback runs exactly once with the response data', async () => {
  const { cam, requests } = makeCam({ responder: renewResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.renew({}, cb);
  await delay(30);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body, /<Renew/);
  assert.equal(cb.calls.length, 1);
  assert.equal(cb.calls[0][0], null);
  assert.ok(cb.calls[0][1]?.terminationTime instanceof Date, 'linerase-parsed renew data reaches the callback');
});

await test('renew(cb): function-first shape is normalized, callback runs once', async () => {
  const { cam } = makeCam({ responder: renewResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.renew(cb);
  await delay(30);
  assert.deepEqual(uncaught, []);
  assert.equal(cb.calls.length, 1);
  assert.equal(cb.calls[0][0], null);
});

await test('renew(): no callback anywhere, still no crash', async () => {
  const { cam } = makeCam({ responder: renewResponder });
  guardUnsubscribe(cam);
  cam.renew();
  await delay(30);
  assert.deepEqual(uncaught, []);
});

await test('renew without a subscription: the sync throw becomes a callback error', async () => {
  const { cam, requests } = makeCam({ withSubscription: false, responder: renewResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.renew({}, cb);
  await delay(10);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 0);
  assert.equal(cb.calls.length, 1);
  assert.match(String(cb.calls[0][0]?.message), /pull-point subscription first/);
});

await test('pullMessages({messageLimit}, cb): options survive the normalization', async () => {
  const { cam, requests } = makeCam({ responder: pullResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.pullMessages({ messageLimit: 5 }, cb);
  await delay(30);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body, /<MessageLimit>5<\/MessageLimit>/, 'the caller-provided limit must not be lost');
  assert.equal(cb.calls.length, 1);
  assert.equal(cb.calls[0][0], null);
});

await test('pullMessages(cb): function-first shape is normalized, callback runs once', async () => {
  const { cam, requests } = makeCam({ responder: pullResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.pullMessages(cb);
  await delay(30);
  assert.deepEqual(uncaught, []);
  assert.equal(cb.calls.length, 1);
  assert.match(requests[0].body, /<MessageLimit>10<\/MessageLimit>/, 'the library default applies');
});

await test('pullMessages without a subscription: the sync throw becomes a callback error', async () => {
  const { cam, requests } = makeCam({ withSubscription: false, responder: pullResponder });
  guardUnsubscribe(cam);
  const cb = spy();
  cam.pullMessages({ messageLimit: 3 }, cb);
  await delay(10);
  assert.deepEqual(uncaught, []);
  assert.equal(requests.length, 0);
  assert.equal(cb.calls.length, 1);
  assert.match(String(cb.calls[0][0]?.message), /pull-point subscription first/);
});

// --------------------------------------------------------------------------
console.log('\nThe library\'s own pull loop: failing pulls must not crash the process');

await test('pull failure -> library-internal unsubscribe({}, cb) -> loop survives', async () => {
  const cam = new onvif.Cam({
    hostname: '127.0.0.1', port: 1, username: 'u', password: 'p', autoconnect: false,
  });
  guardUnsubscribe(cam);
  let pulls = 0;
  let unsubscribes = 0;
  cam._request = (options, cb) => {
    const body = String(options.body ?? '');
    setImmediate(() => {
      if (body.includes('CreatePullPointSubscription')) {
        cb(null, [{
          createPullPointSubscriptionResponse: [{
            subscriptionReference: [{ address: SUB_ADDRESS }],
            currentTime: new Date().toISOString(),
            terminationTime: new Date(Date.now() + 120_000).toISOString(),
          }],
        }], '<xml/>');
      } else if (body.includes('PullMessages')) {
        pulls += 1;
        cb(new Error('device stopped answering pulls'), null, '<xml/>'); // the production trigger
      } else if (body.includes('Unsubscribe')) {
        unsubscribes += 1;
        cb(null, { unsubscribeResponse: [{}] }, '<xml/>');
      } else {
        cb(new Error(`unexpected request in loop test: ${body.slice(0, 120)}`), null, '<xml/>');
      }
    });
  };

  // Adding an 'event' listener starts the library pull loop (newListener
  // hook). A failed pull makes the LIBRARY call this.unsubscribe({}, cb) —
  // the exact shape that crashed production. The library's unsubscribe
  // success path removes 'event' listeners, so re-add to drive another round.
  for (let round = 0; round < 3; round++) {
    cam.on('event', () => {});
    await delay(80);
    cam.removeAllListeners('event');
    await delay(10);
  }
  assert.deepEqual(uncaught, [], `uncaught: ${uncaught.map((e) => e?.message)}`);
  assert.ok(pulls >= 3, `the loop pulled ${pulls} times`);
  assert.ok(unsubscribes >= 3, `the failing pull triggered ${unsubscribes} library-internal unsubscribes`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
