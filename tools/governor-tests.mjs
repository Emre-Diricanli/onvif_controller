/**
 * Behavioral checks for the per-host device governor.
 *
 * This file deliberately knows very little about the implementation. If the
 * governor lands with different testing-hook names, adjust only INTEGRATION.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../server/errors.js';
import { getGovernor, resetGovernor, __testing } from '../server/device/governor.js';

const INTEGRATION = {
  // The governor is per-host internally (getGovernor(host).submit(fn, opts));
  // these tests are written against a host-first facade. Bridge the two here so
  // the behavioral assertions below stay independent of that shape.
  create(options) {
    const hosts = new Map();
    const key = (h) => String(h);
    const of = (h) => {
      if (!hosts.has(key(h))) {
        hosts.set(key(h), new __testing.HostGovernor(key(h), options ?? {}));
      }
      return hosts.get(key(h));
    };
    const PRI = { interactive: 0, normal: 5, bulk: 9 };
    return {
      submit(host, fn, opts = {}) {
        const priority = typeof opts.priority === 'string'
          ? (PRI[opts.priority] ?? PRI.normal)
          : opts.priority;
        return of(host).submit(fn, { ...opts, priority });
      },
      _of: of,
    };
  },
  state(governor, host) {
    return governor._of(host).stats();
  },
  async observe(governor, host, observation) {
    // The governor derives wedge/breaker state from observed failures rather
    // than an external signal, so translate an observation into the failure it
    // represents — and AWAIT it, so state is settled before the test reads it.
    const outcome = typeof observation === 'string' ? observation : observation?.outcome;
    if (outcome === 'connected') return;
    const code = outcome === 'timeout' ? 'DEVICE_TIMEOUT' : 'DEVICE_ERROR';
    const err = Object.assign(new Error(code), { code });
    await governor.submit(host, () => Promise.reject(err)).catch(() => {});
  },
};

const timeoutError = () => Object.assign(new Error('camera timed out'), { code: 'ETIMEDOUT' });
// A timeout is the wedge signature and latches the host; the circuit breaker is
// exercised with an ordinary transport failure instead, so the two states stay
// distinguishable.
const faultError = () => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function eventually(predicate, timeoutMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return true;
    await delay(1);
  }
  return false;
}

async function boundedConcurrencyChecks(check) {
  console.log('\nDevice governor — concurrency');
  const governor = INTEGRATION.create({ concurrency: 2, minSpacingMs: 0 });
  let active = 0;
  let maximum = 0;
  const gates = Array.from({ length: 10 }, deferred);
  const work = gates.map((gate) => governor.submit('bounded.test', async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;
  }, { priority: 'bulk', deadlineMs: 1000 }));

  await eventually(() => active === 2);
  for (const gate of gates) {
    gate.resolve();
    await delay(0);
  }
  await Promise.all(work);
  check('a host never exceeds its concurrency cap', maximum === 2, `peak=${maximum} cap=2`);

  const perHost = INTEGRATION.create({ concurrency: 2, minSpacingMs: 0 });
  const blockers = Array.from({ length: 4 }, deferred);
  const started = [];
  const runs = [0, 1, 2, 3].map((index) => perHost.submit(index < 2 ? 'alpha.test' : 'beta.test', async () => {
    started.push(index < 2 ? 'alpha' : 'beta');
    await blockers[index].promise;
  }, { priority: 'bulk', deadlineMs: 1000 }));
  const bothHostsStarted = await eventually(() => started.filter((x) => x === 'alpha').length === 2
    && started.filter((x) => x === 'beta').length === 2);
  check('different hosts have independent concurrency budgets', bothHostsStarted,
    `started=${started.join(',')}`);
  blockers.forEach((gate) => gate.resolve());
  await Promise.all(runs);
}

async function schedulingChecks(check) {
  console.log('\nDevice governor — pacing and queueing');
  const spacingMs = 5;
  const governor = INTEGRATION.create({ concurrency: 1, minSpacingMs: spacingMs });
  const starts = [];
  await Promise.all(Array.from({ length: 3 }, () => governor.submit('spacing.test', () => {
    starts.push(performance.now());
  }, { priority: 'bulk', deadlineMs: 1000 })));
  const gaps = starts.slice(1).map((time, index) => time - starts[index]);
  check('requests to one host honor minimum spacing', gaps.every((gap) => gap >= spacingMs - 1),
    `gaps=${gaps.map((gap) => gap.toFixed(2)).join(',')}ms`);

  const deadlines = INTEGRATION.create({ concurrency: 1, minSpacingMs: 0 });
  const gate = deferred();
  const first = deadlines.submit('deadline.test', () => gate.promise,
    { priority: 'bulk', deadlineMs: 1000 });
  let queuedCalls = 0;
  const expired = deadlines.submit('deadline.test', () => { queuedCalls += 1; },
    { priority: 'bulk', deadlineMs: 3 });
  const error = await expired.then(() => null, (reason) => reason);
  gate.resolve();
  await first;
  check('a request expiring in the queue fails honestly', error?.code === 'DEVICE_BUSY',
    `code=${error?.code ?? 'none'} message=${error?.message ?? 'none'}`);
  check('an expired queued request is never invoked or retried', queuedCalls === 0,
    `underlying calls=${queuedCalls}`);

  const priority = INTEGRATION.create({ concurrency: 1, minSpacingMs: 0 });
  const firstGate = deferred();
  const order = [];
  const jobs = [priority.submit('priority.test', async () => {
    order.push('bulk-0');
    await firstGate.promise;
  }, { priority: 'bulk', deadlineMs: 1000 })];
  for (let index = 1; index < 5; index += 1) {
    jobs.push(priority.submit('priority.test', () => { order.push(`bulk-${index}`); },
      { priority: 'bulk', deadlineMs: 1000 }));
  }
  jobs.push(priority.submit('priority.test', () => { order.push('interactive'); },
    { priority: 'interactive', deadlineMs: 1000 }));
  await eventually(() => order.length === 1);
  firstGate.resolve();
  await Promise.all(jobs);
  check('interactive work jumps ahead of queued bulk work', order[1] === 'interactive', order.join(' > '));
}

async function breakerChecks(check) {
  console.log('\nDevice governor — circuit breaker');
  const governor = INTEGRATION.create({
    concurrency: 2,
    minSpacingMs: 0,
    failureThreshold: 3,
    cooldownMs: 5,
  });
  let underlyingCalls = 0;
  for (let index = 0; index < 3; index += 1) {
    await governor.submit('breaker.test', () => {
      underlyingCalls += 1;
      throw faultError();
    }, { priority: 'interactive', deadlineMs: 1000 }).catch(() => {});
  }
  const callsAtOpen = underlyingCalls;
  const openError = await governor.submit('breaker.test', () => { underlyingCalls += 1; },
    { priority: 'interactive', deadlineMs: 1000 }).then(() => null, (error) => error);
  check('consecutive transport failures open the breaker',
    INTEGRATION.state(governor, 'breaker.test').breakerState === 'open');
  check('an open breaker fails fast with a stated reason', Boolean(openError)
    && /open|unavailable|paused|circuit/i.test(`${openError.code ?? ''} ${openError.message ?? ''}`));
  check('an open breaker never calls underlying work', underlyingCalls === callsAtOpen,
    `before=${callsAtOpen} after=${underlyingCalls}`);

  await delay(7);
  const probeGate = deferred();
  let probeCalls = 0;
  const attempts = Array.from({ length: 5 }, () => governor.submit('breaker.test', async () => {
    probeCalls += 1;
    await probeGate.promise;
    return 'healthy';
  }, { priority: 'interactive', deadlineMs: 1000 }));
  await eventually(() => probeCalls === 1);
  check('half-open permits exactly one probe', probeCalls === 1, `probe calls=${probeCalls}`);
  probeGate.resolve();
  await Promise.allSettled(attempts);
}

async function wedgeAndObservabilityChecks(check) {
  console.log('\nDevice governor — wedge detection and observability');
  const governor = INTEGRATION.create({ concurrency: 1, minSpacingMs: 0 });
  const host = 'wedged.test';
  await INTEGRATION.observe(governor, host, { protocol: 'tcp', outcome: 'connected' });
  await INTEGRATION.observe(governor, host, { protocol: 'onvif', outcome: 'timeout' });
  await INTEGRATION.observe(governor, host, { protocol: 'rtsp', outcome: 'timeout' });
  const wedgedState = INTEGRATION.state(governor, host);
  check('TCP success plus ONVIF and RTSP timeouts marks a host wedged',
    wedgedState.wedged === true || wedgedState.breakerState === 'wedged', JSON.stringify(wedgedState));
  let calls = 0;
  const error = await governor.submit(host, () => { calls += 1; },
    { priority: 'interactive', deadlineMs: 1000 }).then(() => null, (reason) => reason);
  check('further traffic to a wedged host stops', calls === 0 && Boolean(error),
    `underlying calls=${calls}`);

  const visible = INTEGRATION.create({ concurrency: 1, minSpacingMs: 0 });
  const gate = deferred();
  const running = visible.submit('visible.test', () => gate.promise,
    { priority: 'bulk', deadlineMs: 1000 });
  const queued = visible.submit('visible.test', () => {},
    { priority: 'bulk', deadlineMs: 1000 });
  await eventually(() => {
    const state = INTEGRATION.state(visible, 'visible.test');
    return state.inFlight === 1 && state.queueDepth === 1;
  });
  const state = INTEGRATION.state(visible, 'visible.test');
  check('queue depth is observable', state.queueDepth === 1, JSON.stringify(state));
  check('in-flight count is observable', state.inFlight === 1, JSON.stringify(state));
  check('breaker state is observable', typeof state.breakerState === 'string', JSON.stringify(state));
  gate.resolve();
  await Promise.all([running, queued]);
}

async function classificationAndRecoveryChecks(check) {
  console.log('\nDevice governor — protocol answers and operator recovery');
  const governor = INTEGRATION.create({ minSpacingMs: 0 });
  const host = 'protocol.test';
  const reject = (err) => governor.submit(host, () => { throw err; }).catch((error) => error);
  for (let i = 0; i < 6; i += 1) await reject(new AppError('UNSUPPORTED', 'Not supported'));
  check('repeated UNSUPPORTED leaves healthy commands available',
    await governor.submit(host, () => 'healthy').catch(() => 'blocked') === 'healthy');
  for (const code of ['UNSUPPORTED', 'BAD_REQUEST', 'UNAUTHORIZED', 'NOT_FOUND', 'CLOCK_SKEW', 'DEVICE_ERROR']) {
    await reject(timeoutError());
    const error = new AppError(code, 'SOAP fault: operation timeout');
    const returned = await reject(error);
    const state = INTEGRATION.state(governor, host);
    check(`${code} preserves the error and resets both failure streaks`, returned === error
      && state.consecutiveFailures === 0 && state.consecutiveTimeouts === 0 && !state.wedged);
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ERR_SOCKET_CLOSED']) {
    const g = new __testing.HostGovernor(code, { minSpacingMs: 0, breakerThreshold: 1 });
    const error = new AppError('DEVICE_ERROR', 'Device error');
    error.cause = Object.assign(new Error('transport failure'), { code });
    await g.submit(() => { throw error; }).catch(() => {});
    check(`DEVICE_ERROR with ${code} cause opens the breaker`, g.stats().breakerState === 'open');
  }
  const mapped = new __testing.HostGovernor('hint.test', { minSpacingMs: 0 });
  for (let i = 0; i < 2; i += 1) {
    await mapped.submit(() => { throw new AppError('DEVICE_ERROR', 'Device error', 'socket timeout'); }).catch(() => {});
  }
  check('transport timeout hints count toward the wedge', mapped.stats().wedged);

  const recoveryHost = 'operator-recovery.test';
  const recovery = getGovernor(recoveryHost, { minSpacingMs: 0, breakerCooldownMs: 1 });
  await recovery.submit(() => { throw timeoutError(); }).catch(() => {});
  await recovery.submit(() => { throw timeoutError(); }).catch(() => {});
  await delay(5);
  check('wedge remains latched after cooldown', recovery.stats().wedged);
  const reset = resetGovernor(recoveryHost);
  check('operator reset clears wedge, reason and failure streaks', reset.breakerState === 'closed'
    && reset.wedgeReason === null && reset.consecutiveFailures === 0 && reset.consecutiveTimeouts === 0);
  check('reset host accepts commands again', await recovery.submit(() => 'recovered') === 'recovered');
  recovery.openUntil = Date.now() + 30000;
  check('operator reset also clears an open breaker', resetGovernor(recoveryHost).breakerState === 'closed');
  __testing.governors.delete(recoveryHost);
}

async function recoveryRouteChecks(check) {
  const { default: router } = await import('../server/routes/device.js');
  const { createSession, destroySession } = await import('../server/sessions.js');
  const session = createSession({ host: 'route-recovery.test', capabilities: {}, profiles: [], profileMap: new Map() });
  const other = getGovernor('other-recovery.test');
  const governor = getGovernor(session.host, { minSpacingMs: 0 });
  governor.markWedged('Two consecutive timeouts');
  other.markWedged('Other host');
  const call = (path, method, id) => new Promise((resolve) => {
    const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route;
    route.stack[0].handle({ params: { id }, body: { host: 'other-recovery.test' } },
      { json: (body) => resolve({ body }) }, (error) => resolve({ error }));
  });
  try {
    const status = await call('/governor', 'get', session.id);
    check('status route exposes the session host and wedge reason', status.body?.host === session.host
      && status.body?.breakerState === 'wedged' && status.body?.wedgeReason === 'Two consecutive timeouts');
    const denied = await call('/governor/reset', 'post', 'missing-session');
    check('reset route requires a valid session', denied.error?.code === 'SESSION_EXPIRED' && governor.stats().wedged);
    const deniedStatus = await call('/governor', 'get', 'missing-session');
    check('status route requires a valid session', deniedStatus.error?.code === 'SESSION_EXPIRED');
    const result = await call('/governor/reset', 'post', session.id);
    check('reset route recovers only the session host', result.body?.breakerState === 'closed' && other.stats().wedged);
    check('commands work after route recovery', await governor.submit(() => 'healthy') === 'healthy');
  } finally {
    destroySession(session.id);
    __testing.governors.delete(session.host);
    __testing.governors.delete('other-recovery.test');
  }
}

export async function governorChecks(check) {
  await boundedConcurrencyChecks(check);
  await schedulingChecks(check);
  await breakerChecks(check);
  await wedgeAndObservabilityChecks(check);
  await classificationAndRecoveryChecks(check);
  await recoveryRouteChecks(check);
}
