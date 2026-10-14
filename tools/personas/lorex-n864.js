/**
 * Persona: Lorex N864A6 — an 8-channel 4K NVR on Dahua OEM firmware, so it
 * answers the same Dahua HTTP API (CGI) as dahua-ipc (shared engine, same
 * Digest/qop=auth, same Error bodies, same modes). Differences encoded here:
 *
 *   - getProductDefinition reports the IP-camera slots in
 *     MaxRemoteInputChannels=8 and no local inputs (VideoInputChannels=0).
 *   - getVendor answers "Lorex".
 *   - Per-channel defaults are distinct (brightness 40,45,50,..., bitrates
 *     stepping by 256 kbps) so a write that leaks across channels shows up.
 *
 * Model string and table contents are assumed from vendor docs, not
 * hardware-verified.
 */
import { createDahuaPersona } from './dahua-ipc.js';

const TITLES = ['Front Door', 'Driveway', 'Backyard', 'Garage', 'Side Gate', 'Porch', 'Patio', 'Office'];

export const persona = createDahuaPersona({
  name: 'lorex-n864',
  info: {
    deviceType: 'N864A6',
    version: '4.001.0000000.3.R,build:2021-09-10',
    serial: 'ND0221070012345',
    vendor: 'Lorex',
  },
  product: { VideoInputChannels: '0', MaxRemoteInputChannels: '8', MaxExtraStream: '1' },
  channels: 8,
  defaults: (ch) => ({
    title: TITLES[ch],
    brightness: 40 + ch * 5,
    contrast: 45 + ch * 2,
    saturation: 55 + ch,
    sharpness: 30 + ch * 3,
    main: { codec: 'H.265', width: 3840, height: 2160, fps: 15, bitrate: 6144 + ch * 256, rateControl: 'VBR', gop: 30 },
    sub: { codec: 'H.264', width: 640, height: 480, fps: 10, bitrate: 384 + ch * 32, rateControl: 'CBR', gop: 20 },
  }),
});
