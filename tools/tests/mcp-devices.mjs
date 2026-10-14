/**
 * Stream 4 — device discovery/session, PTZ, and maintenance tools, driven
 * through the MCP protocol against the mock camera + a live controller.
 *
 * The mock is single-channel with PTZ (tools/mock-camera.js): one media profile
 * "main", a PTZ node "default" with presets P001..P020 + Home, model
 * "Mockup Model". Its /__calls and /__reset endpoints let us assert what the
 * camera actually RECEIVED (e.g. that ptz_move always sends a Stop, and that a
 * destructive call without confirm never reaches the device).
 */
import { startHarness, createChecker, freePort } from '../../mcp/test/harness.mjs';

const t = createChecker('mcp devices / ptz / maintenance');

/** Read the mock camera's per-operation call counts (proof of what it received). */
const mockCalls = async (port) => (await fetch(`http://127.0.0.1:${port}/__calls`)).json();
const mockReset = async (port) => { await fetch(`http://127.0.0.1:${port}/__reset`, { method: 'POST' }); };
/** No credential value or key may ever appear in a serialized tool result. */
const leaksSecret = (obj) => /password|username|secret|admin|hunter/i.test(JSON.stringify(obj));

const h = await startHarness();
try {
  t.section('list_devices');
  const list1 = h.json(await h.call('list_devices'));
  const mock = (list1?.devices ?? []).find((d) => d.name === 'mock-cam');
  t.check('list_devices includes the configured mock-cam', Boolean(mock), JSON.stringify(list1).slice(0, 200));
  t.check('mock-cam points at the mock host/port', mock?.host === '127.0.0.1' && mock?.port === h.mockPort, JSON.stringify(mock));
  t.check('mock-cam carries its label and notes', mock?.label === 'Mock camera' && typeof mock?.notes === 'string');
  t.check('list_devices exposes no credential key', Object.keys(mock ?? {}).every((k) => !/password|username|secret|credential/i.test(k)), Object.keys(mock ?? {}).join(','));
  t.check('list_devices JSON contains no password anywhere', !leaksSecret(list1), JSON.stringify(list1).slice(0, 300));

  t.section('discover_devices');
  const disc = await h.call('discover_devices', { timeout_ms: 1000 });
  const discBody = h.json(disc);
  // Discovery legitimately finds nothing (no WS-Discovery on loopback); the
  // contract is that it returns a list rather than erroring.
  t.check('discover_devices returns a device list', !disc.isError && Array.isArray(discBody?.devices), h.text(disc).slice(0, 160));

  t.section('connect_device (ad-hoc handle)');
  const conn = await h.call('connect_device', { host: '127.0.0.1', port: h.mockPort, username: 'admin', password: 'admin' });
  const connBody = h.json(conn);
  t.check('connect_device succeeds', !conn.isError, h.text(conn).slice(0, 200));
  t.check('connect_device returns handle adhoc-1', connBody?.ref === 'adhoc-1', JSON.stringify(connBody).slice(0, 200));
  t.check('connect_device negotiated onvif', connBody?.protocol === 'onvif', JSON.stringify(connBody));
  t.check('connect_device reports a model', typeof connBody?.model === 'string' && connBody.model.length > 0, JSON.stringify(connBody));
  t.check('connect_device reports ptz capability', connBody?.capabilities?.ptz === true, JSON.stringify(connBody?.capabilities));
  t.check('connect_device result leaks no password', !leaksSecret(connBody), JSON.stringify(connBody).slice(0, 300));

  const list2 = h.json(await h.call('list_devices'));
  const adhoc = (list2?.devices ?? []).find((d) => d.name === 'adhoc-1');
  t.check('list_devices now shows adhoc-1', Boolean(adhoc), JSON.stringify(list2?.devices?.map((d) => d.name)));
  t.check('adhoc-1 is connected over onvif', adhoc?.connected === true && adhoc?.protocol === 'onvif', JSON.stringify(adhoc));
  t.check('adhoc-1 is flagged ad-hoc', adhoc?.adhoc === true);
  t.check('list_devices (with handle) still leaks no password', !leaksSecret(list2));

  t.section('device_info');
  const info = await h.call('device_info', { device: 'mock-cam' });
  const infoBody = h.json(info);
  t.check('device_info succeeds', !info.isError, h.text(info).slice(0, 200));
  t.check('device_info returns the model', infoBody?.device?.model === 'Mockup Model', JSON.stringify(infoBody?.device));
  t.check('device_info returns firmware', typeof infoBody?.device?.firmware === 'string' && infoBody.device.firmware.length > 0, JSON.stringify(infoBody?.device));
  t.check('device_info returns manufacturer + serial', typeof infoBody?.device?.manufacturer === 'string' && 'serial' in (infoBody?.device ?? {}));
  t.check('device_info lists profiles', Array.isArray(infoBody?.profiles) && infoBody.profiles.length >= 1, JSON.stringify(infoBody?.profiles));
  const p0 = infoBody?.profiles?.[0] ?? {};
  t.check('profile carries codec/resolution/fps', p0.codec === 'H264' && p0.resolution === '1920x1080' && typeof p0.fps === 'number', JSON.stringify(p0));
  t.check('device_info reports PTZ support', infoBody?.ptz?.supported === true, JSON.stringify(infoBody?.ptz));
  t.check('device_info reports clock skew (seconds)', 'clockSkewSeconds' in infoBody, JSON.stringify(Object.keys(infoBody ?? {})));
  t.check('device_info leaks no password', !leaksSecret(infoBody));

  t.section('disconnect_device');
  const disc1 = h.json(await h.call('disconnect_device', { device: 'adhoc-1' }));
  t.check('disconnect_device reports forgotten handle', disc1?.disconnected === true && disc1?.forgotten === true, JSON.stringify(disc1));
  const list3 = h.json(await h.call('list_devices'));
  t.check('adhoc-1 is forgotten after disconnect', !(list3?.devices ?? []).some((d) => d.name === 'adhoc-1'), JSON.stringify(list3?.devices?.map((d) => d.name)));
  const discUnknown = await h.call('disconnect_device', { device: 'adhoc-1' });
  t.check('disconnecting a forgotten handle is a clean error', discUnknown.isError === true && /UNKNOWN_DEVICE/.test(h.text(discUnknown)), h.text(discUnknown));

  t.section('ptz_move always stops');
  // Establish the session, then clear counters so we see only this move.
  await h.call('ptz_status', { device: 'mock-cam' });
  await mockReset(h.mockPort);
  const move = await h.call('ptz_move', { device: 'mock-cam', pan: 0.5, tilt: 0, zoom: 0, duration_ms: 300 });
  const moveBody = h.json(move);
  t.check('ptz_move succeeds', !move.isError, h.text(move).slice(0, 200));
  t.check('ptz_move reports it stopped', moveBody?.stopped === true, JSON.stringify(moveBody));
  const moveCalls = await mockCalls(h.mockPort);
  t.check('ptz_move sent ContinuousMove to the device', (moveCalls.ContinuousMove ?? 0) >= 1, JSON.stringify(moveCalls));
  t.check('ptz_move ALWAYS sent Stop to the device', (moveCalls.Stop ?? 0) >= 1, JSON.stringify(moveCalls));
  const afterStatus = h.json(await h.call('ptz_status', { device: 'mock-cam' }));
  t.check('camera is not moving after ptz_move', afterStatus?.moving === false, JSON.stringify(afterStatus));
  t.check('ptz_status returns a normalized position', afterStatus?.position && typeof afterStatus.position.pan === 'number', JSON.stringify(afterStatus?.position));

  t.section('ptz presets');
  const presets = h.json(await h.call('ptz_list_presets', { device: 'mock-cam' }));
  t.check('ptz_list_presets returns presets', Array.isArray(presets?.presets) && presets.presets.length > 0, JSON.stringify(presets).slice(0, 160));
  const save = h.json(await h.call('ptz_save_preset', { device: 'mock-cam', name: 'AgentTest' }));
  t.check('ptz_save_preset returns a token and the name', typeof save?.token === 'string' && save?.name === 'AgentTest', JSON.stringify(save));
  const goto = await h.call('ptz_goto_preset', { device: 'mock-cam', name: 'p001' });
  const gotoBody = h.json(goto);
  t.check('ptz_goto_preset by name (case-insensitive) succeeds', !goto.isError, h.text(goto).slice(0, 200));
  t.check('ptz_goto_preset resolved the name to token P001', gotoBody?.token === 'P001', JSON.stringify(gotoBody));
  const gotoUnknown = await h.call('ptz_goto_preset', { device: 'mock-cam', name: 'does-not-exist' });
  t.check('ptz_goto_preset with an unknown name is NOT_FOUND', gotoUnknown.isError === true && /NOT_FOUND/.test(h.text(gotoUnknown)), h.text(gotoUnknown).slice(0, 160));

  await mockReset(h.mockPort);
  const delNo = await h.call('ptz_delete_preset', { device: 'mock-cam', token: 'P001' });
  t.check('ptz_delete_preset without confirm -> CONFIRMATION_REQUIRED', delNo.isError === true && /CONFIRMATION_REQUIRED/.test(h.text(delNo)), h.text(delNo).slice(0, 160));
  t.check('no RemovePreset reached the device without confirm', ((await mockCalls(h.mockPort)).RemovePreset ?? 0) === 0, JSON.stringify(await mockCalls(h.mockPort)));
  const delYes = await h.call('ptz_delete_preset', { device: 'mock-cam', token: 'P001', confirm: true });
  t.check('ptz_delete_preset with confirm succeeds', !delYes.isError, h.text(delYes).slice(0, 200));
  t.check('RemovePreset reached the device with confirm', ((await mockCalls(h.mockPort)).RemovePreset ?? 0) >= 1, JSON.stringify(await mockCalls(h.mockPort)));

  t.section('reboot_device (confirm gate)');
  await mockReset(h.mockPort);
  const rbNo = await h.call('reboot_device', { device: 'mock-cam' });
  t.check('reboot_device without confirm -> CONFIRMATION_REQUIRED', rbNo.isError === true && /CONFIRMATION_REQUIRED/.test(h.text(rbNo)), h.text(rbNo).slice(0, 160));
  t.check('no reboot happened without confirm', ((await mockCalls(h.mockPort)).SystemReboot ?? 0) === 0, JSON.stringify(await mockCalls(h.mockPort)));
  const rbYes = await h.call('reboot_device', { device: 'mock-cam', confirm: true });
  const rbBody = h.json(rbYes);
  t.check('reboot_device with confirm succeeds', !rbYes.isError && rbBody?.rebooting === true, h.text(rbYes).slice(0, 200));
  t.check('SystemReboot reached the device with confirm', ((await mockCalls(h.mockPort)).SystemReboot ?? 0) >= 1, JSON.stringify(await mockCalls(h.mockPort)));
  const listAfterReboot = h.json(await h.call('list_devices'));
  const mockAfter = (listAfterReboot?.devices ?? []).find((d) => d.name === 'mock-cam');
  t.check('session disconnected after reboot (reconnects on next use)', mockAfter?.connected === false, JSON.stringify(mockAfter));

  t.section('sync_time');
  await mockReset(h.mockPort);
  const st = await h.call('sync_time', { device: 'mock-cam' });
  const stText = h.text(st);
  // Primary proof the tool works: it drove ONVIF SetSystemDateAndTime through the
  // controller to the device.
  t.check('sync_time drives SetSystemDateAndTime to the device', ((await mockCalls(h.mockPort)).SetSystemDateAndTime ?? 0) >= 1, JSON.stringify(await mockCalls(h.mockPort)));
  // KNOWN MOCK LIMITATION (not a tool bug): the frozen tools/mock-camera.js replays
  // SetSystemDateAndTime.xml with its doT template UNPROCESSED, so the response body
  // is the literal text "{{? it.bad }}wrong response{{?}}". The onvif library requires
  // that element to be exactly empty (cam.js: `setSystemDateAndTimeResponse !== ''`),
  // so it rejects the mock and the controller honestly reports DEVICE_ERROR. Accept
  // either real success (if the mock is later fixed) or that clean, mapped error —
  // never a crash, never a secret. See the commit message (request to Stream 1).
  const stOk = !st.isError ? (h.json(st)?.synced === true) : false;
  const stKnownMockLimit = st.isError === true && /DEVICE_ERROR/.test(stText) && /SetSystemDateAndTime/.test(stText);
  t.check('sync_time returns a clean result (ok, or the known mock-fixture error)', stOk || stKnownMockLimit, stText.slice(0, 200));
  t.check('sync_time result leaks no secret and no stack trace', !/supersecret|password|admin|\bat \S+\.js:\d/i.test(stText), stText.slice(0, 200));

  t.section('set_relay (confirm gate)');
  const relayNo = await h.call('set_relay', { device: 'mock-cam', token: 'RelayOutput_0', state: 'active' });
  t.check('set_relay without confirm -> CONFIRMATION_REQUIRED', relayNo.isError === true && /CONFIRMATION_REQUIRED/.test(h.text(relayNo)), h.text(relayNo).slice(0, 160));

  t.section('connect_device failure is scrubbed');
  const deadPort = await freePort();
  const bad = await h.call('connect_device', { host: '127.0.0.1', port: deadPort, username: 'admin', password: 'supersecret123', protocol: 'onvif' });
  t.check('connect_device to a dead host is an error', bad.isError === true, h.text(bad).slice(0, 200));
  t.check('connect_device error carries a code', /^[A-Z_]+:/.test(h.text(bad)), h.text(bad).slice(0, 120));
  t.check('connect_device error never echoes the password', !/supersecret123/i.test(h.text(bad)), h.text(bad).slice(0, 300));
} finally {
  await h.close();
}

t.section('read-only mode');
const ro = await startHarness({ readOnly: true });
try {
  const roList = await ro.call('list_devices');
  t.check('read-only allows list_devices', !roList.isError && Array.isArray(ro.json(roList)?.devices), ro.text(roList).slice(0, 160));
  const roInfo = await ro.call('device_info', { device: 'mock-cam' });
  t.check('read-only allows device_info', !roInfo.isError, ro.text(roInfo).slice(0, 200));
  const roConn = await ro.call('connect_device', { host: '127.0.0.1', port: ro.mockPort, username: 'admin', password: 'admin' });
  t.check('read-only refuses connect_device', roConn.isError === true && /READ_ONLY/.test(ro.text(roConn)), ro.text(roConn).slice(0, 160));
  const roMove = await ro.call('ptz_move', { device: 'mock-cam', pan: 0.5, duration_ms: 200 });
  t.check('read-only refuses ptz_move', roMove.isError === true && /READ_ONLY/.test(ro.text(roMove)), ro.text(roMove).slice(0, 160));
  const roReboot = await ro.call('reboot_device', { device: 'mock-cam', confirm: true });
  t.check('read-only refuses reboot_device even with confirm', roReboot.isError === true && /READ_ONLY/.test(ro.text(roReboot)), ro.text(roReboot).slice(0, 160));
} finally {
  await ro.close();
}

t.done();
process.exit(t.failed ? 1 : 0);
