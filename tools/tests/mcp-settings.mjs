/**
 * MCP settings, snapshot and prompts (Stream 3), driven through the MCP
 * protocol against the mock camera and a real controller.
 */
import http from 'node:http';
import { startHarness, createChecker, freePort } from '../../mcp/test/harness.mjs';

const t = createChecker('mcp settings, snapshot, prompts');
const DEV = 'mock-cam';

/** Every text block's JSON payload (results put JSON first, a summary line second). */
const jsonOf = (res) => {
  for (const b of res?.content ?? []) {
    if (b.type !== 'text') continue;
    try { return JSON.parse(b.text); } catch { /* summary text */ }
  }
  return null;
};
const textOf = (res) => (res?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/*
 * The mock camera advertises a snapshot URI but answers it with a SOAP 400.
 * This pass-through proxy fronts it, rewrites the advertised addresses to
 * itself, and serves a tiny JPEG on plain GETs, so get_snapshot is tested
 * end to end through the controller's real snapshot proxy.
 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
async function startSnapshotProxy(mockPort) {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && !req.url.startsWith('/__')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
      res.end(JPEG);
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = http.request({ host: '127.0.0.1', port: mockPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${mockPort}` } }, (upRes) => {
        const out = [];
        upRes.on('data', (c) => out.push(c));
        upRes.on('end', () => {
          const body = Buffer.from(Buffer.concat(out).toString('utf8').replaceAll(`127.0.0.1:${mockPort}`, `127.0.0.1:${port}`));
          const headers = { ...upRes.headers, 'content-length': body.length };
          delete headers['transfer-encoding'];
          res.writeHead(upRes.statusCode, headers);
          res.end(body);
        });
      });
      up.on('error', () => { res.writeHead(502).end(); });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const h = await startHarness();
let proxy = null;
try {
  t.section('tools are registered with honest annotations');
  const listed = await h.listTools();
  const byName = new Map(listed.map((x) => [x.name, x]));
  for (const n of ['list_targets', 'describe_settings', 'read_settings', 'get_snapshot']) {
    t.check(`${n} is read-only`, byName.get(n)?.annotations?.readOnlyHint === true);
  }
  t.check('write_settings is a non-destructive write', byName.get('write_settings')?.annotations?.readOnlyHint === false
    && !byName.get('write_settings')?.annotations?.destructiveHint && !byName.get('write_settings')?.inputSchema?.properties?.confirm);
  t.check('write_stream_settings is destructive and gated', byName.get('write_stream_settings')?.annotations?.destructiveHint === true
    && Boolean(byName.get('write_stream_settings')?.inputSchema?.properties?.confirm));

  t.section('list_targets');
  const targets = jsonOf(await h.call('list_targets', { device: DEV }));
  const source = targets?.targets?.find((x) => x.scope === 'source');
  const stream = targets?.targets?.find((x) => x.scope === 'stream');
  t.check('returns source and stream targets', Boolean(source && stream), JSON.stringify(targets));
  t.check('reports protocol', targets?.protocol === 'onvif');
  t.check('stream has a parent and channel', stream?.parent === source?.id && stream?.channel === 1);

  t.section('describe_settings');
  const desc = jsonOf(await h.call('describe_settings', { device: DEV, target: source.id }));
  const brightness = desc?.groups?.imaging?.find((d) => d.key === 'image.brightness');
  t.check('image.brightness is described with a range', typeof brightness?.range === 'string' && /\.\./.test(brightness.range), JSON.stringify(brightness));
  t.check('descriptors are grouped and say writable', brightness?.writable === true);
  const [bMin, bMax] = brightness.range.split('..').map(Number);

  t.section('read_settings');
  const read = jsonOf(await h.call('read_settings', { device: DEV, target: source.id }));
  const b0 = read?.settings?.['image.brightness'];
  t.check('returns values merged with ranges', typeof b0?.value === 'number' && b0?.range === brightness.range, JSON.stringify(b0));
  const onlyOne = jsonOf(await h.call('read_settings', { device: DEV, target: source.id, keys: ['image.contrast'] }));
  t.check('keys limits the read', Object.keys(onlyOne?.settings ?? {}).join() === 'image.contrast', JSON.stringify(onlyOne));
  const badKey = await h.call('read_settings', { device: DEV, target: source.id, keys: ['image.nope'] });
  t.check('unknown key is a clear error', badKey.isError === true && /image\.nope/.test(textOf(badKey)));

  const brightnessNow = async () => jsonOf(await h.call('read_settings', { device: DEV, target: source.id, keys: ['image.brightness'] }))
    ?.settings?.['image.brightness']?.value;
  const startValue = b0.value;
  const newValue = startValue > bMin + 10 ? startValue - 10 : startValue + 10;

  t.section('write_settings dry run');
  const dry = await h.call('write_settings', { device: DEV, target: source.id, values: { 'image.brightness': newValue }, dry_run: true });
  const plan = jsonOf(dry);
  t.check('dry run reports the plan current -> requested', !dry.isError && plan?.dryRun === true
    && plan?.changes?.['image.brightness']?.current === startValue && plan?.changes?.['image.brightness']?.requested === newValue, JSON.stringify(plan));
  t.check('dry run says nothing was written', /nothing was written/i.test(textOf(dry)));
  t.check('dry run did not change the device', await brightnessNow() === startValue);

  t.section('write_settings');
  const wrote = await h.call('write_settings', { device: DEV, target: source.id, values: { 'image.brightness': newValue } });
  const outcome = jsonOf(wrote)?.results?.['image.brightness'];
  t.check('applies image.brightness with outcome applied', !wrote.isError && outcome?.outcome === 'applied' && outcome?.observed === newValue, textOf(wrote));
  t.check('summary line names the outcome', /applied: image\.brightness/.test(textOf(wrote)));
  t.check('read_settings confirms the write', await brightnessNow() === newValue);

  const oor = await h.call('write_settings', { device: DEV, target: source.id, values: { 'image.brightness': bMax + 1000 } });
  t.check('out-of-range is an error naming the range', oor.isError === true && /out of range/.test(textOf(oor)) && textOf(oor).includes(brightness.range), textOf(oor));
  t.check('out-of-range wrote nothing', await brightnessNow() === newValue);
  const wrongType = await h.call('write_settings', { device: DEV, target: source.id, values: { 'image.brightness': 'bright' } });
  t.check('wrong type is an error', wrongType.isError === true && /must be a number/.test(textOf(wrongType)));
  const ro = await h.call('write_settings', { device: DEV, target: source.id, values: { 'image.sharpness': 10 } });
  t.check('read-only key is an error', ro.isError === true && /read-only/.test(textOf(ro)));

  const res = await h.call('write_settings', { device: DEV, target: stream.id, values: { 'video.resolution': '1280x720' } });
  t.check('write_settings refuses video.resolution and points to write_stream_settings',
    res.isError === true && /write_stream_settings/.test(textOf(res)), textOf(res));
  const preview = await h.call('write_settings', { device: DEV, target: stream.id, values: { 'video.resolution': '1280x720' }, dry_run: true });
  t.check('write_settings dry_run can preview a resolution change and warns of the restart',
    !preview.isError && jsonOf(preview)?.changes?.['video.resolution']?.requested === '1280x720' && /restart/.test(textOf(preview)), textOf(preview));

  t.section('write_stream_settings');
  const sDesc = jsonOf(await h.call('describe_settings', { device: DEV, target: stream.id }));
  const fps = sDesc?.groups?.encoder?.find((d) => d.key === 'video.fps');
  const sRead = jsonOf(await h.call('read_settings', { device: DEV, target: stream.id }));
  const fps0 = sRead?.settings?.['video.fps']?.value;
  const [fMin] = fps.range.split('..').map(Number);
  const fps1 = fps0 > fMin ? fps0 - 1 : fps0 + 1;
  const gated = await h.call('write_stream_settings', { device: DEV, target: stream.id, values: { 'video.fps': fps1 } });
  t.check('without confirm -> CONFIRMATION_REQUIRED', gated.isError === true && /CONFIRMATION_REQUIRED/.test(textOf(gated)));
  t.check('without confirm nothing changed', jsonOf(await h.call('read_settings', { device: DEV, target: stream.id, keys: ['video.fps'] }))
    ?.settings?.['video.fps']?.value === fps0);
  const wrongScope = await h.call('write_stream_settings', { device: DEV, target: source.id, values: { 'image.brightness': newValue }, confirm: true });
  t.check('refuses a non-stream target', wrongScope.isError === true && /write_settings/.test(textOf(wrongScope)));
  const sw = await h.call('write_stream_settings', { device: DEV, target: stream.id, values: { 'video.fps': fps1 }, confirm: true });
  const fpsOutcome = jsonOf(sw)?.results?.['video.fps'];
  t.check('with confirm, video.fps is applied', !sw.isError && fpsOutcome?.outcome === 'applied', textOf(sw));

  t.section('get_snapshot');
  const viaMock = await h.call('get_snapshot', { device: DEV });
  // The mock serves a real JPEG at its advertised snapshot URI (tools/mock-camera.js).
  const mockImg = viaMock.content?.find((b) => b.type === 'image');
  t.check('mock-cam snapshot arrives as an image block', !viaMock.isError && mockImg?.mimeType === 'image/jpeg' && mockImg.data.length > 1000, textOf(viaMock));
  t.check('snapshot text never echoes credentials', !/admin:|password/i.test(textOf(viaMock)));
  proxy = await startSnapshotProxy(h.mockPort);
  const { ref: snapCam } = await h.ctx.sessions.connect({ host: '127.0.0.1', port: proxy.port, username: 'admin', password: 'admin' });
  const snap = await h.call('get_snapshot', { device: snapCam });
  const img = snap.content?.find((b) => b.type === 'image');
  t.check('returns an image/jpeg block', !snap.isError && img?.mimeType === 'image/jpeg' && img?.data?.length > 0, textOf(snap));
  t.check('image bytes are the JPEG', Buffer.from(img?.data ?? '', 'base64').equals(JPEG));
  t.check('plus a caption with device and profile', textOf(snap).includes(snapCam) && /profile/.test(textOf(snap)));
  const byChannel = await h.call('get_snapshot', { device: snapCam, channel: 1 });
  t.check('channel 1 resolves to a profile', !byChannel.isError && /channel 1/.test(textOf(byChannel)), textOf(byChannel));
  const noChannel = await h.call('get_snapshot', { device: snapCam, channel: 9 });
  t.check('a missing channel is a clear error', noChannel.isError === true && /channel 9/.test(textOf(noChannel)));

  t.section('prompts');
  const prompts = (await h.client.listPrompts()).prompts.map((p) => p.name);
  t.check('prompts are listed', ['tune_picture', 'optimize_stream', 'diagnose_device'].every((n) => prompts.includes(n)), prompts.join(','));
  for (const [name, args] of [['tune_picture', { device: DEV, goal: 'windows blown out' }], ['optimize_stream', { device: DEV, goal: 'bandwidth' }], ['diagnose_device', { device: DEV }]]) {
    const p = await h.client.getPrompt({ name, arguments: args });
    const body = p.messages?.[0]?.content?.text ?? '';
    t.check(`${name} renders with the device name`, body.includes(`"${DEV}"`) && body.length > 400);
  }
  const tp = await h.client.getPrompt({ name: 'tune_picture', arguments: { device: DEV } });
  t.check('tune_picture works without the optional goal', /get_snapshot/.test(tp.messages[0].content.text));
} finally {
  await proxy?.close();
  await h.close();
}

t.section('a stub camera that ignores imaging writes');
const stub = await startHarness({ mockEnv: { MOCK_IMAGING_MODE: 'ignore' } });
try {
  const targets = jsonOf(await stub.call('list_targets', { device: DEV }));
  const source = targets.targets.find((x) => x.scope === 'source');
  const before = jsonOf(await stub.call('read_settings', { device: DEV, target: source.id }))?.settings?.['image.brightness']?.value;
  const value = before > 20 ? before - 10 : before + 10;
  const res = await stub.call('write_settings', { device: DEV, target: source.id, values: { 'image.brightness': value } });
  t.check('outcome is unchanged', jsonOf(res)?.results?.['image.brightness']?.outcome === 'unchanged', textOf(res));
  t.check('the tool warns that the device ignored the write', /ignored the write/.test(textOf(res)), textOf(res));
} finally {
  await stub.close();
}

t.done();
process.exit(t.failed ? 1 : 0);
