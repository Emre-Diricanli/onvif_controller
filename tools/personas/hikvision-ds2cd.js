/**
 * Persona: Hikvision DS-2CD2143G2-I — a single fixed camera speaking ISAPI.
 * One video input (channel 1), streams 101 (main) and 102 (sub). The device
 * model lives in hikvision-common.js; see its header for strictness and modes.
 */
import { hikvisionPersona } from './hikvision-common.js';

export const persona = hikvisionPersona({
  name: 'hikvision-ds2cd',
  model: 'DS-2CD2143G2-I',
  deviceType: 'IPCamera',
  channels: 1,
  recorder: false,
  channelName: () => 'Camera 01',
  defaults: () => ({ brightness: 50 }),
});
