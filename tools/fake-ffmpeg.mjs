#!/usr/bin/env node
/**
 * A stand-in for ffmpeg that needs no camera.
 *
 * The streaming pipeline resolves its binary through FFMPEG_PATH, so pointing
 * that at this script exercises the real pipeline — spawn, fragmented-MP4 box
 * parsing, WebSocket transport and MSE handoff — against a synthetic video
 * source instead of an RTSP camera. Everything downstream of the RTSP
 * negotiation is genuinely under test.
 *
 * It rewrites only the input: `-i <rtsp url>` becomes an lavfi test pattern,
 * and `-c:v copy` becomes a real encode (there is nothing to copy from a raw
 * synthetic source). Every other argument the pipeline chose — the movflags,
 * the fragment duration, pipe:1 — is passed through untouched, which is the
 * whole point.
 */
import { spawn } from 'node:child_process';

const SOURCE = process.env.FAKE_FFMPEG_SOURCE
  ?? 'testsrc2=size=320x180:rate=10';
const REAL = process.env.FAKE_FFMPEG_REAL ?? '/opt/homebrew/bin/ffmpeg';

const argv = process.argv.slice(2);
const out = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];

  if (arg === '-rtsp_transport') { i += 1; continue; }      // no RTSP here
  if (arg === '-i') {
    out.push('-f', 'lavfi', '-i', SOURCE);
    i += 1;                                                  // drop the URL
    continue;
  }
  if (arg === '-c:v' && argv[i + 1] === 'copy') {
    // A synthetic source has no encoded stream to copy.
    out.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
             '-pix_fmt', 'yuv420p', '-g', '10');
    i += 1;
    continue;
  }
  out.push(arg);
}

// Bound the run so a forgotten child cannot outlive the test.
if (!out.includes('-t')) out.unshift('-t', String(process.env.FAKE_FFMPEG_DURATION ?? 30));

const child = spawn(REAL, ['-re', ...out], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill('SIGKILL'); } catch {} process.exit(0); });
}
