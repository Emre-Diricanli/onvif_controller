/**
 * Expert prompts: camera-technician workflows the agent can be started with.
 * They are checklists over the tools, not new capabilities, so they stay in
 * plain text and only reference tool names that exist (settings.js,
 * snapshot.js, core.js, devices.js).
 *
 * Prompt arguments are strings in MCP, so optional choices (goal) are plain
 * strings, interpreted here.
 */
import { z } from 'zod';

const user = (textBody) => ({ messages: [{ role: 'user', content: { type: 'text', text: textBody } }] });

/** Site notes from the config travel with the prompt, so the agent knows e.g. "faces west windows". */
function deviceLine(device, ctx) {
  const d = ctx?.devices?.get?.(device);
  if (!d) return `Device: "${device}".`;
  const extra = [d.label, d.notes].filter(Boolean).join(' — ');
  return `Device: "${device}"${extra ? ` (${extra})` : ''}.`;
}

const DEVICE_ARG = z.string().describe('Device name from list_devices, or a connect_device handle (e.g. "adhoc-1").');

const STREAM_GOALS = {
  bandwidth: 'BANDWIDTH: lowest bitrate that still looks acceptable. Prefer H.265, VBR with a cap, lower fps (10–15), longer GOP (2× fps), substream for live view.',
  quality: 'QUALITY: best detail for evidence/recording. Main stream at native resolution, bitrate toward the top of the range below, CBR or high VBR cap, H.264 High or H.265.',
  smooth: 'SMOOTH: fluid motion and fast live start. 25–30 fps, GOP = 1× fps (one I-frame per second), CBR to avoid bitrate starvation in motion, H.264 for widest client support.',
};

export const prompts = [
  {
    name: 'tune_picture',
    title: 'Tune the picture',
    description: 'Expert image-tuning workflow: look first, change one or two imaging parameters in small steps, verify each with a snapshot, report before/after.',
    argsSchema: {
      device: DEVICE_ARG,
      goal: z.string().optional().describe('What is wrong or wanted, in plain words, e.g. "windows blown out", "night image noisy", "colors washed out".'),
    },
    build({ device, goal }, ctx) {
      return user(`You are a CCTV technician tuning the picture of one camera.
${deviceLine(device, ctx)}
Goal: ${goal?.trim() || 'make the image as clear and natural as possible for this scene'}.

Workflow
1. list_targets → pick the source/channel target (imaging lives there, not on stream targets).
2. describe_settings on it → note writable keys, native ranges and units (ranges differ per brand: 0..100, 0..255 — never assume).
3. read_settings → record the ORIGINAL values. You will report against them.
4. get_snapshot → describe what you see: exposure, highlights, shadows, noise, colour, sharpness, time of day (IR/mono = night).
5. Change ONE parameter (two only if tightly coupled) in a small step (~10% of its range), with write_settings.
6. Check the outcome: applied/adjusted is fine; unchanged = device ignored it (stop retrying that key, tell the user); rejected = refused; unknown = read_settings before anything else.
7. get_snapshot again and compare. Keep the change only if it is visibly better; otherwise restore the previous value.
8. Repeat 5–7. Stop when the goal is met or further steps stop helping.

Typical issues → first things to try
- Bright windows/sky blown out, faces dark: image.wdr on (then image.wdrLevel moderate); else image.blc. Do not just drop brightness.
- Noisy/smeared night image: check image.dayNight (auto/night) and image.irLight; lower image.sharpness (sharpening amplifies noise); don't raise brightness to compensate.
- Colour at night / pink cast in daylight: image.dayNight stuck or IR-cut issue — set auto, or force day/night to test.
- Washed-out, flat colours: raise image.saturation and image.contrast a step each, separately.
- Soft image: raise image.sharpness slightly; if still soft it is focus or a dirty dome — say so, don't over-sharpen.
- Mirrored/upside-down: image.mirror / image.flip.

Rules
- Never change encoder (video.*), network or system settings in this task without asking the user first.
- Never set values outside the described range; never write keys you did not intend to change.
- If every write comes back unchanged, the device ignores ONVIF imaging writes: say so and suggest the vendor web UI.

Finish with a table: key | original | final | why, plus a final get_snapshot.`);
    },
  },

  {
    name: 'optimize_stream',
    title: 'Optimize the video stream',
    description: 'Encoder tuning guidance with concrete bitrate/fps/GOP numbers for a goal (bandwidth, quality or smooth), applied via write_stream_settings after user approval.',
    argsSchema: {
      device: DEVICE_ARG,
      goal: z.string().optional().describe('One of "bandwidth", "quality" or "smooth". Omit for a balanced setup.'),
    },
    build({ device, goal }, ctx) {
      const key = String(goal ?? '').trim().toLowerCase();
      const goalLine = STREAM_GOALS[key] ?? 'BALANCED: good recording quality at a sane bitrate; substream light enough for live grids.';
      return user(`You are a CCTV technician optimizing the encoder settings of one device.
${deviceLine(device, ctx)}
Goal — ${goalLine}

Workflow
1. list_targets → the stream targets (main, sub, third) per channel. Main = recording/evidence, sub = live view and multi-camera grids.
2. describe_settings + read_settings on each stream → current codec, resolution, fps, bitrateMode, bitrate (kbps), gop, and the allowed values/ranges.
3. Compare with the reference numbers below and propose a concrete change per stream (current → proposed, and why). Use write_stream_settings with dry_run: true to validate.
4. Show the plan to the user and get explicit approval. Codec/resolution changes restart live streams and can break recorders/VMS clients that expect the old format.
5. Apply with write_stream_settings and confirm: true, one stream at a time. Check outcomes; on unknown, read_settings before retrying.
6. get_snapshot (and ask the user to check live view/recording) to confirm it still works.

Reference bitrates (kbps; H.265 ≈ 50–60% of H.264 for the same quality)
- 4K / 8MP (3840x2160) @15fps: H.264 8000–12000 | H.265 4000–6000
- 5MP (2592x1944/2880x1616) @15fps: H.264 5000–8000 | H.265 2500–4000
- 4MP (2560x1440) @15fps: H.264 4000–6000 | H.265 2000–3000
- 1080p @15fps: H.264 2000–4000 | H.265 1000–2000   (@25–30fps: ×1.5)
- 720p @15fps: H.264 1000–2000 | H.265 512–1024
- Substream D1/640x480/640x360 @10–15fps: 256–768 (H.264 is safest for browser/phone live view)
Busy scenes (trees, traffic, rain, night noise) need the top of the range; static indoor scenes the bottom.

Other rules of thumb
- fps: 10–15 is enough for most surveillance; 25–30 for traffic, cash desks, fast motion. More fps = more bitrate.
- GOP (video.gop) = 1–2× fps (e.g. 15 fps → GOP 15–30). Longer GOP saves bandwidth but slows live start and seeking; very long GOPs smear on packet loss.
- CBR: predictable bandwidth (good on constrained uplinks, NVR budgets); wastes bits on static scenes, starves on busy ones. VBR: better quality per bit; set bitrate as the cap you can afford.
- H.265 halves storage but some browsers, VMS and older NVRs cannot decode it — ask before switching codec.
- H.264 profile: high > main > baseline for efficiency; use main/baseline only for very old decoders.
- Keep the substream light: a 16-camera grid × 4 Mbps main streams overloads clients; grids should use substreams.

Never touch imaging, network or system settings in this task. Report a table: stream | key | before | after | outcome.`);
    },
  },

  {
    name: 'diagnose_device',
    title: 'Diagnose a device',
    description: 'Systematic health check of a camera or recorder: controller reachability, device info, targets, snapshot and settings, summarized with likely causes.',
    argsSchema: { device: DEVICE_ARG },
    build({ device }, ctx) {
      return user(`You are a CCTV technician diagnosing one device. Read-only: do not change anything unless the user asks.
${deviceLine(device, ctx)}

Checks, in order (note each result; keep going after a failure where it makes sense)
1. list_controllers → is the controller that serves this device reachable? Unreachable = controller down, wrong URL, or token problem — stop and report.
2. device_info (if available) → manufacturer, model, firmware, clock skew. Skew > ~5 s breaks ONVIF auth (WS-Security) and event/recording timestamps → suggest time sync/NTP.
3. list_targets → protocol and channels/streams. Fewer channels than expected on an NVR = channels offline or not ONVIF-exposed. Vendor-only protocol = ONVIF disabled or a separate ONVIF user missing (common on Hikvision/Dahua).
4. get_snapshot (each channel on a recorder) → black = lens covered/IR failure/offline channel; grey/frozen = channel offline; blur = focus or dirty dome; mono in daylight = day/night stuck; pink/magenta = IR-cut filter stuck; error UNSUPPORTED = no ONVIF media.
5. read_settings on a source and on each stream → odd values: brightness/contrast at an extreme, sharpness maxed (noise), dayNight forced, bitrate far off for the resolution, GOP > 4× fps, fps very low.

Error codes → likely cause
- UNAUTHORIZED: wrong credentials, or the device needs a dedicated ONVIF user (Hikvision) / ONVIF auth enabled.
- DEVICE_UNREACHABLE / DEVICE_TIMEOUT: IP/port wrong, device offline, firewall, wrong VLAN; ONVIF port is often not 80 (e.g. 8000, 8080, 2020).
- CLOCK_SKEW: device time wrong → sync time.
- SESSION_EXPIRED is handled automatically; repeated = controller restarting.
- Writes that come back "unchanged": ONVIF stub firmware; settings only work through the vendor API/web UI.

Finish with: summary (OK / warnings / faults), the evidence for each, likely causes ranked, and suggested next steps (which tool, which value) for the user to approve.`);
    },
  },
];
