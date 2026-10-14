/**
 * Persona: Hikvision DS-7604NI-K1 — a 4-channel NVR speaking ISAPI.
 *
 * The recorder shape that matters: /ISAPI/System/Video/inputs/channels is
 * notSupport (an NVR has no local sensors); channels come from
 * /ISAPI/ContentMgmt/InputProxy/channels; streams are 101/102 … 401/402; each
 * channel has DISTINCT imaging defaults, so a write that lands on the wrong
 * channel is visible. See hikvision-common.js for strictness and modes.
 */
import { hikvisionPersona } from './hikvision-common.js';

const NAMES = { 1: 'Front Door', 2: 'Loading Bay', 3: 'Parking Lot', 4: 'Back Office' };

export const persona = hikvisionPersona({
  name: 'hikvision-nvr',
  model: 'DS-7604NI-K1',
  deviceType: 'NVR',
  channels: 4,
  recorder: true,
  channelName: (n) => NAMES[n],
  defaults: (n) => ({ brightness: 40 + n * 5 }),
});
