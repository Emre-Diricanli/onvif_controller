import { execFileSync } from 'node:child_process';
import { AppError } from './errors.js';
import { existsSync } from 'node:fs';

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    return existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : null;
  }
  try {
    const found = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
    return found || null;
  } catch {
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

const argv = process.argv.slice(2);
const hostFlagIndex = argv.indexOf('--host');
const explicitHost = hostFlagIndex !== -1 ? argv[hostFlagIndex + 1] : null;

export const config = {
  port: Number(process.env.PORT ?? 8080),
  /** Loopback by default; exposing the app also exposes camera control. */
  host: explicitHost ?? process.env.HOST ?? '127.0.0.1',
  ffmpegPath: resolveFfmpeg(),
  onvifTimeoutMs: Number(process.env.ONVIF_TIMEOUT_MS ?? 10000),
  sessionIdleMs: Number(process.env.SESSION_IDLE_MS ?? 30 * 60 * 1000),
  /** Warn rather than fail: digest auth breaks well before this becomes fatal. */
  clockSkewWarnSeconds: 60,
};

export function assertFfmpeg() {
  if (!config.ffmpegPath) {
    throw new AppError(
      'FFMPEG_MISSING',
      'ffmpeg was not found on PATH.',
      'Install ffmpeg (on macOS: brew install ffmpeg) or set FFMPEG_PATH to its absolute location, then restart the server.',
    );
  }
  return config.ffmpegPath;
}

export function warnIfExposed() {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn(
      `\n  WARNING: binding ${config.host} exposes full camera control (PTZ, reboot,\n` +
      '  relay outputs) to anyone who can reach this port. There is no app-level\n' +
      '  authentication. Only do this on a trusted management network.\n',
    );
  }
}
