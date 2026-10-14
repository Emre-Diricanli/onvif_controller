/**
 * Settings tools: targets, descriptors, values and verified writes, over the
 * controller's protocol-neutral Settings API (API.md "Settings", ADAPTERS.md
 * §2-§6). The same five tools work on ONVIF and every vendor adapter.
 */
import { z } from 'zod';
import { defineTool, result, json, text, ToolError } from '../lib/kit.js';

const DEVICE = z.string().describe('Device name from list_devices, or a handle returned by connect_device (e.g. "adhoc-1").');
const TARGET = z.string().describe('Target id from list_targets, passed back verbatim (e.g. "source:VideoSource_1"). Ids are opaque: never build one yourself.');
const VALUE = z.union([z.string(), z.number(), z.boolean()]);
const VALUES = z.record(z.string(), VALUE)
  .describe('Settings to change: key -> new value, in the native units/ranges from describe_settings, e.g. {"image.brightness": 60}. Only the keys given are written.');
const DRY_RUN = z.boolean().default(false)
  .describe('true = validate keys, types and ranges and show the planned change (current -> requested) without writing anything.');

/*
 * Codec and resolution invalidate every live stream of the profile, so they
 * only go through write_stream_settings, whose destructiveHint makes the core
 * demand confirm. Annotations are static per tool, hence two tools.
 */
const STREAM_RESTART_KEYS = new Set(['video.codec', 'video.resolution']);

/** "0..100" (plus the step when it is not 1), or null when the device gave no range. */
function rangeOf(d) {
  if (d.min === undefined && d.max === undefined) return null;
  const r = `${d.min ?? '-inf'}..${d.max ?? 'inf'}`;
  return d.step !== undefined && d.step !== 1 ? `${r} step ${d.step}` : r;
}

/** The parts of a descriptor an agent needs; drops nulls and the lock key. */
function shape(d) {
  const out = { key: d.key, label: d.label, type: d.type };
  if (d.unit) out.unit = d.unit;
  const range = rangeOf(d);
  if (range) out.range = range;
  if (d.type === 'enum' && Array.isArray(d.values)) out.values = d.values;
  out.writable = d.writable === true;
  return out;
}

async function descriptorsFor(client, sid, target) {
  const res = await client.describeSettings(sid, target);
  return { source: res?.source ?? null, list: res?.descriptors ?? [], byKey: new Map((res?.descriptors ?? []).map((d) => [d.key, d])) };
}

/*
 * Agents often send "60" or "true" as strings. Converting those is still the
 * value they asked for; anything that does not convert cleanly is left as-is
 * and fails the type check below, so nothing is guessed.
 */
function coerce(d, value) {
  if ((d.type === 'int' || d.type === 'number') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  if (d.type === 'bool' && typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  return value;
}

function typeProblem(d, value) {
  switch (d.type) {
    case 'int': return Number.isInteger(value) ? null : 'must be an integer';
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'bool': return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum': return typeof value === 'string' && d.values?.includes(value) ? null : `must be one of ${(d.values ?? []).join(', ')}`;
    case 'string': return typeof value === 'string' ? null : 'must be a string';
    default: return `has an unknown type "${d.type}"`;
  }
}

/**
 * Mirrors the controller's validatePatch (server/settings/contract.js), but
 * collects every problem at once so the agent can fix them in one round.
 * Returns the coerced patch; throws BAD_REQUEST listing all problems.
 */
function validate(values, byKey, target) {
  const entries = Object.entries(values ?? {});
  if (!entries.length) throw new ToolError('BAD_REQUEST', 'values is empty: give at least one key -> value to change.');
  const patch = {};
  const problems = [];
  for (const [key, raw] of entries) {
    const d = byKey.get(key);
    if (!d) { problems.push(`"${key}" is not a setting of ${target}`); continue; }
    if (!d.writable) { problems.push(`"${key}" is read-only on this device`); continue; }
    const value = coerce(d, raw);
    const bad = typeProblem(d, value);
    if (bad) { problems.push(`"${key}" ${bad} (got ${JSON.stringify(raw)})`); continue; }
    if ((d.type === 'int' || d.type === 'number')
      && ((d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max))) {
      problems.push(`"${key}" = ${value} is out of range ${rangeOf(d)}${d.unit ? ` ${d.unit}` : ''}`);
      continue;
    }
    patch[key] = value;
  }
  if (problems.length) {
    throw new ToolError('BAD_REQUEST', `Nothing was written. ${problems.join('; ')}.`,
      'Call describe_settings for this target to see valid keys, types and ranges.');
  }
  return patch;
}

async function targetScope(client, sid, target) {
  const res = await client.targets(sid);
  const found = (res?.targets ?? []).find((t) => t.id === target);
  if (!found) {
    throw new ToolError('NOT_FOUND', `This device has no target "${target}".`, 'Call list_targets and pass an id back verbatim.');
  }
  return found.scope;
}

function plan(patch, current, byKey) {
  const changes = {};
  for (const [key, requested] of Object.entries(patch)) {
    const d = byKey.get(key);
    changes[key] = { current: current?.[key] ?? null, requested, ...(d.unit ? { unit: d.unit } : {}), ...(rangeOf(d) ? { range: rangeOf(d) } : {}) };
  }
  return changes;
}

/** One line a human (or the agent) can act on, derived only from the outcomes. */
function summarize(results) {
  const rows = Object.entries(results ?? {});
  const by = (o) => rows.filter(([, r]) => r?.outcome === o).map(([k]) => k);
  const parts = [];
  for (const o of ['applied', 'adjusted', 'unchanged', 'rejected', 'unknown']) {
    const keys = by(o);
    if (keys.length) parts.push(`${o}: ${keys.join(', ')}`);
  }
  const lines = [`Write result — ${parts.join('; ') || 'no fields reported'}.`];
  if (rows.length && by('unchanged').length === rows.length) {
    lines.push('WARNING: the device ignored the write (every field read back unchanged). Many ONVIF stubs accept writes and do nothing; '
      + 'retrying will not help. Tell the user; the setting may only be changeable in the vendor web UI.');
  }
  if (by('adjusted').length) lines.push('Adjusted fields were clamped or quantized by the device; see "observed" for the value it actually uses.');
  if (by('rejected').length) lines.push('Rejected fields were explicitly refused by the device; they were not changed.');
  if (by('unknown').length) {
    lines.push('Some fields are UNKNOWN: the write was sent but could not be confirmed. Do NOT retry blindly — call read_settings first '
      + 'and only write again if the value is still wrong.');
  }
  return lines.join('\n');
}

async function doWrite(args, ctx, { stream }) {
  const { device, target, values, dry_run: dryRun = false } = args;
  if (!stream && !dryRun) {
    const blocked = Object.keys(values ?? {}).filter((k) => STREAM_RESTART_KEYS.has(k));
    if (blocked.length) {
      throw new ToolError('USE_WRITE_STREAM_SETTINGS',
        `${blocked.join(' and ')} restart live streams, so write_settings does not change them. Nothing was written.`,
        'Use write_stream_settings (it needs confirm: true after the user agrees). write_settings with dry_run: true can preview it.');
    }
  }
  return ctx.sessions.use(device, async (client, sid) => {
    if (stream) {
      const scope = await targetScope(client, sid, target);
      if (scope !== 'stream') {
        throw new ToolError('BAD_REQUEST', `write_stream_settings changes encoder settings of a stream target; "${target}" is a ${scope} target. Nothing was written.`,
          'Use write_settings for imaging and other non-stream settings, or pick a "stream:" target from list_targets.');
      }
    }
    const { byKey, source } = await descriptorsFor(client, sid, target);
    const patch = validate(values, byKey, target);
    if (dryRun) {
      const current = await client.readSettings(sid, target, Object.keys(patch));
      const changes = plan(patch, current?.values, byKey);
      const restarts = Object.keys(patch).filter((k) => STREAM_RESTART_KEYS.has(k));
      const lines = [`Dry run: nothing was written. ${Object.keys(changes).length} field(s) are valid and would change as shown.`];
      if (restarts.length) lines.push(`${restarts.join(' and ')} will restart live streams: apply with write_stream_settings and confirm: true after the user agrees.`);
      return result(json({ dryRun: true, device, target, source, changes }), text(lines.join('\n')));
    }
    const res = await client.writeSettings(sid, target, patch);
    const body = { device, target: res?.target ?? target, source: res?.source ?? source, results: res?.results ?? {}, values: res?.values ?? {} };
    if (res?.fallbackFrom) body.fallbackFrom = res.fallbackFrom;
    if (res?.streamRestartRequired !== undefined) body.streamRestartRequired = res.streamRestartRequired;
    if (res?.streamsRestarted !== undefined) body.streamsRestarted = res.streamsRestarted;
    let summary = summarize(body.results);
    if (body.fallbackFrom) summary += `\nThe ${body.fallbackFrom} write was ignored, so it was retried through the ${body.source} API (later writes to this target go there).`;
    if (body.streamsRestarted) summary += '\nLive streams of this profile were restarted.';
    if (Object.keys(patch).some((k) => k.startsWith('image.'))) summary += '\nTake a get_snapshot to check the picture.';
    return result(json(body), text(summary));
  });
}

const OUTCOMES_DOC = 'Returns per-field outcomes: applied (read-back matches), adjusted (device clamped/quantized; see observed), '
  + 'unchanged (device ignored it), rejected (device refused), unknown (sent but unconfirmed: read_settings before any retry), '
  + 'plus a one-line summary.';

export const tools = [
  defineTool({
    name: 'list_targets',
    title: 'List setting targets',
    description: 'Lists the addressable parts of a device that settings belong to: channels, sources (sensors, where imaging lives) '
      + 'and streams (encoders), with scope, label, 1-based channel number and parent, plus the protocol and model. '
      + 'Call this first on any device; every settings tool needs a target id from here. Ids are opaque: pass them back '
      + 'verbatim and never infer one from a channel number. Read-only.',
    inputSchema: { device: DEVICE },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device }, ctx) {
      return ctx.sessions.use(device, async (client, sid, entry) => {
        const res = await client.targets(sid);
        const info = entry.session?.device ?? {};
        return result(json({
          device,
          protocol: res?.protocol ?? entry.session?.protocol ?? null,
          manufacturer: info.manufacturer ?? null,
          model: info.model ?? null,
          targets: res?.targets ?? [],
        }), text('Imaging settings live on source/channel targets; encoder settings (video.*) on stream targets. '
          + 'Next: describe_settings on a target.'));
      });
    },
  }),

  defineTool({
    name: 'describe_settings',
    title: 'Describe settings of a target',
    description: 'Lists every setting a target supports, grouped (imaging, encoder, osd, …): key, label, type '
      + '(int|number|enum|bool|string), unit, range "min..max" (native units, not rescaled), enum values and whether it is writable. '
      + 'Call after list_targets and before any write. Keys are canonical (image.*, video.*: same meaning on every brand) or '
      + 'vendor.<adapter>.<name> (device-specific). Read-only.',
    inputSchema: { device: DEVICE, target: TARGET },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device, target }, ctx) {
      return ctx.sessions.use(device, async (client, sid) => {
        const { list, source } = await descriptorsFor(client, sid, target);
        const groups = {};
        for (const d of list) (groups[d.group ?? 'other'] ??= []).push(shape(d));
        return result(json({ device, target, source, count: list.length, groups }));
      });
    },
  }),

  defineTool({
    name: 'read_settings',
    title: 'Read current settings',
    description: 'Reads the current values of a target\'s settings, each merged with its unit, range and enum values, e.g. '
      + '{"image.brightness": {"value": 50, "range": "0..100"}}. Use before changing anything (to know the starting point) and '
      + 'after a write that reported unknown. Optional keys limits the read. Call list_targets first for the target id. Read-only.',
    inputSchema: {
      device: DEVICE,
      target: TARGET,
      keys: z.array(z.string()).optional().describe('Only these keys (from describe_settings). Omit to read every readable setting.'),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    async handler({ device, target, keys }, ctx) {
      return ctx.sessions.use(device, async (client, sid) => {
        const { byKey } = await descriptorsFor(client, sid, target);
        const unknown = (keys ?? []).filter((k) => !byKey.has(k));
        if (unknown.length) {
          throw new ToolError('BAD_REQUEST', `Not settings of ${target}: ${unknown.join(', ')}.`, 'Call describe_settings to see the valid keys.');
        }
        const res = await client.readSettings(sid, target, keys);
        const settings = {};
        for (const [key, value] of Object.entries(res?.values ?? {})) {
          const d = byKey.get(key);
          if (!d) { settings[key] = { value }; continue; }
          const { key: _k, label, ...rest } = shape(d);
          settings[key] = { value, label, ...rest };
        }
        return result(json({ device, target, source: res?.source ?? null, settings }));
      });
    },
  }),

  defineTool({
    name: 'write_settings',
    title: 'Change settings',
    description: 'Changes setting values on one target (imaging such as brightness, contrast, WDR, day/night; OSD; non-restarting '
      + 'encoder values). Call describe_settings and read_settings first; change one or two values at a time. dry_run: true validates '
      + 'and shows current -> requested without writing. Refuses to write video.codec/video.resolution (dry_run may preview them): use write_stream_settings. '
      + OUTCOMES_DOC + ' Writes only the keys given; verified by read-back.',
    inputSchema: { device: DEVICE, target: TARGET, values: VALUES, dry_run: DRY_RUN },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: (args, ctx) => doWrite(args, ctx, { stream: false }),
  }),

  defineTool({
    name: 'write_stream_settings',
    title: 'Change stream encoder settings',
    description: 'Changes encoder settings on a stream target: video.codec, video.resolution, video.fps, video.bitrate, '
      + 'video.bitrateMode, video.gop, video.profile and vendor encoder keys. Codec/resolution changes restart live streams and can '
      + 'break recorders or VMS clients, so describe the change and get the user\'s approval before calling with confirm: true. '
      + 'Call describe_settings on the stream target first. dry_run: true previews without writing. ' + OUTCOMES_DOC,
    inputSchema: { device: DEVICE, target: TARGET.describe('A "stream" target id from list_targets, passed back verbatim (e.g. "stream:Profile_1").'), values: VALUES, dry_run: DRY_RUN },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: (args, ctx) => doWrite(args, ctx, { stream: true }),
  }),
];
