import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { redactUri } from '../onvif/util.js';

const STDERR_TAIL_LINES = 12;

/** ffmpeg echoes the input URL, credentials included. Never let that reach a log. */
function scrubCredentials(text) {
  return String(text).replace(/(rtsps?|https?):\/\/[^\s'"<>]+/gi, '$1://***');
}

const streams = new Map();
const children = new Set();
const DEFAULT_MIME = 'video/mp4; codecs="avc1.42E01E"';
const HEALTHY_RUN_MS = 30_000;
const MAX_GOP_BYTES = 16 * 1024 * 1024;
const MAX_GOP_FRAGMENTS = 300;
/** How long a stream survives with no viewers, so a reconnect can reattach. */
const VIEWER_GRACE_MS = 5_000;

function killChild(child, context = 'stream teardown') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { return; }
  const warningTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      console.warn(`[stream] ffmpeg did not exit within 2s of SIGKILL during ${context}.`);
    }
  }, 2_000);
  warningTimer.unref?.();
  child.once('close', () => clearTimeout(warningTimer));
}

function killAllChildren(context) {
  for (const child of children) killChild(child, context);
}

function readBox(buffer, offset = 0) {
  if (buffer.length - offset < 8) return null;
  let size = buffer.readUInt32BE(offset);
  let headerSize = 8;
  if (size === 1) {
    if (buffer.length - offset < 16) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 box is too large.');
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    return null;
  }
  if (size < headerSize) throw new Error('Invalid MP4 box size.');
  if (buffer.length - offset < size) return null;
  return { size, headerSize, type: buffer.toString('ascii', offset + 4, offset + 8) };
}

function findAvcC(buffer, start = 0, end = buffer.length, info = null) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(buffer.subarray(0, end), offset);
    if (!box || offset + box.size > end) break;
    const payloadStart = offset + box.headerSize;
    if (info && (box.type === 'avc1' || box.type === 'avc3') && box.size >= box.headerSize + 28) {
      info.width = buffer.readUInt16BE(payloadStart + 24);
      info.height = buffer.readUInt16BE(payloadStart + 26);
    }
    if (box.type === 'avcC' && box.size >= box.headerSize + 4) {
      return buffer.subarray(payloadStart, offset + box.size);
    }
    // Container boxes used on the path to the AVC sample entry. stsd and avc1
    // have fixed fields before their child boxes.
    const skips = { moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, stsd: 8, avc1: 78, avc3: 78 };
    if (Object.hasOwn(skips, box.type)) {
      const found = findAvcC(buffer, payloadStart + skips[box.type], offset + box.size, info);
      if (found) return found;
    }
    offset += box.size;
  }
  return null;
}

function mimeFromMoov(moov, info) {
  try {
    const avcC = findAvcC(moov, 0, moov.length, info);
    if (!avcC || avcC.length < 4) return DEFAULT_MIME;
    const codec = `avc1.${[avcC[1], avcC[2], avcC[3]].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return `video/mp4; codecs="${codec}"`;
  } catch {
    return DEFAULT_MIME;
  }
}

/** Read child boxes without assuming ffmpeg always uses the same optional fields. */
function boxes(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    const box = readBox(buffer, offset);
    if (!box) throw new Error('Incomplete MP4 box.');
    result.push({ type: box.type, body: buffer.subarray(offset + box.headerSize, offset + box.size) });
    offset += box.size;
  }
  return result;
}

function firstSampleIsKeyframe(moof, defaultFlags) {
  try {
    const traf = boxes(boxes(moof)[0].body).find((box) => box.type === 'traf');
    if (!traf) return false;
    const children = boxes(traf.body);
    const tfhd = children.find((box) => box.type === 'tfhd')?.body;
    const trun = children.find((box) => box.type === 'trun')?.body;
    if (!tfhd || !trun || trun.readUInt32BE(4) === 0) return false;
    const flags = tfhd.readUInt32BE(0) & 0xffffff;
    let offset = 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0)
      + ((flags & 8) ? 4 : 0) + ((flags & 16) ? 4 : 0);
    let sampleFlags = (flags & 32) ? tfhd.readUInt32BE(offset) : defaultFlags;
    const runFlags = trun.readUInt32BE(0) & 0xffffff;
    offset = 8 + ((runFlags & 1) ? 4 : 0);
    if (runFlags & 4) sampleFlags = trun.readUInt32BE(offset);
    else if (runFlags & 0x400) {
      offset += ((runFlags & 0x100) ? 4 : 0) + ((runFlags & 0x200) ? 4 : 0);
      sampleFlags = trun.readUInt32BE(offset);
    }
    return sampleFlags !== undefined && !(sampleFlags & 0x10000)
      && ((sampleFlags >>> 24) & 3) !== 1;
  } catch {
    return false;
  }
}

function outputVideo(profile) {
  const { width, height, fps } = profile.video;
  const outputWidth = width > 0 ? Math.max(2, Math.floor(Math.min(width, 1920) / 2) * 2) : null;
  return {
    width: outputWidth,
    height: outputWidth && height > 0 ? Math.max(2, Math.round(height * outputWidth / width / 2) * 2) : null,
    fps: fps > 0 ? Math.min(fps, 30) : 30,
  };
}

export class StreamHandle extends EventEmitter {
  constructor(session, profile) {
    super();
    // Avoid EventEmitter throwing if ffmpeg fails between HTTP startup and the
    // WebSocket attaching its error listener.
    this.on('error', () => {});
    this.streamId = `s-${randomUUID()}`;
    this.sessionId = session.id;
    this.profile = profile;
    this.initSegment = null;
    this.mime = DEFAULT_MIME;
    this.viewers = 0;
    this.child = null;
    this.stopped = false;
    this.degraded = false;
    this.restartTimer = null;
    this.orphanTimer = null;
    this.failures = 0;
    this.initTimer = null;
    this.initializedAt = null;
    this.initTimeoutMs = profile.video.width >= 3840 || profile.video.height >= 2160
      || !/^(h\.?264|avc)$/i.test(profile.video.codec || '') ? 20_000 : 12_000;
    /**
     * Replay after initSegment to prime a late viewer. Always begins at a sync
     * sample and contains the complete current GOP so far, in wire order.
     * Updated before fragment is emitted (its last entry is that fragment).
     * Read this property again each time; the array is replaced at keyframes.
     * Empty until a keyframe arrives, after restart, or if the GOP exceeds the
     * memory bound. Consumers must wait for a new keyframe when it is empty.
     */
    this.gopCache = [];
    this.gopBytes = 0;
    this.defaultSampleFlags = undefined;
    this.stderrPending = '';
    this.stderrDiscarding = false;
    // The last lines ffmpeg wrote, kept so a failure can say WHY. Without this
    // a dead stream logs nothing and the only symptom is "degraded".
    this.stderrTail = [];
    this.parserBuffer = Buffer.alloc(0);
    this.initBoxes = [];
    this.pendingMoof = null;
    this.lastStatsAt = 0;
    this.stats = { bitrateKbps: 0, fps: profile.video.fps || 0, droppedFrames: 0 };
    this.info = {
      streamId: this.streamId,
      transcoding: !/^(h\.?264|avc)$/i.test(profile.video.codec || ''),
      codec: profile.video.codec,
      mime: this.mime,
      width: profile.video.width,
      height: profile.video.height,
      fps: profile.video.fps,
    };
    if (this.info.transcoding) Object.assign(this.info, outputVideo(profile));
  }

  addViewer() {
    if (this.stopped) return false;
    clearTimeout(this.orphanTimer);
    this.orphanTimer = null;
    this.viewers += 1;
    return true;
  }

  removeViewer() {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers !== 0) return;
    // Don't kill ffmpeg the instant a socket blips: the player reconnects with
    // backoff, and tearing the pipeline down forces a full respawn and a second
    // of black video for what is often a momentary drop. The timer is bounded,
    // so this defers the kill rather than risking an orphan — and an explicit
    // stop or session teardown still kills immediately.
    clearTimeout(this.orphanTimer);
    this.orphanTimer = setTimeout(() => {
      if (this.viewers === 0) stopStream(this.streamId);
    }, VIEWER_GRACE_MS);
    this.orphanTimer.unref?.();
  }

  spawn() {
    if (this.stopped || this.child) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.initializedAt = null;
    this.gopCache = [];
    this.gopBytes = 0;
    this.defaultSampleFlags = undefined;
    this.stderrTail = [];
    this.stderrPending = '';
    this.stderrDiscarding = false;
    this.parserBuffer = Buffer.alloc(0);
    this.initBoxes = [];
    this.pendingMoof = null;
    this.initSegment = null;
    const transcode = this.info.transcoding;
    const videoArgs = transcode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-vf', "scale=w='max(2,trunc(min(iw,1920)/2)*2)':h=-2",
        ...(this.profile.video.fps > 0 ? ['-r', String(this.info.fps)] : ['-fpsmax', '30']),
        '-g', String(Math.max(1, Math.round(this.info.fps * 2))),
        '-pix_fmt', 'yuv420p']
      : ['-c:v', 'copy'];
    /* Bound probing without starving large SPS/PPS or an RTSP keyframe. These
     * input options exist in both ffmpeg 6 and 7; timeout is microseconds, not
     * the RTSP server's listen_timeout. Only video is needed for this pipeline. */
    const args = [
      '-hide_banner', '-loglevel', 'info', '-rtsp_transport', 'tcp',
      '-timeout', '5000000', '-analyzeduration', '1000000', '-probesize', '2000000',
      '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', this.profile.rtspUri,
      '-map', '0:v:0', ...videoArgs, '-an', '-avoid_negative_ts', 'make_zero', '-f', 'mp4',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration', '200000', 'pipe:1',
    ];
    const child = spawn(config.ffmpegPath || 'ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    children.add(child);
    /* Every retry needs its own deadline too: a hung retry must not occupy the
     * handle forever after the original HTTP startup deadline has gone away. */
    this.initTimer = setTimeout(() => {
      this.initTimer = null;
      if (this.child !== child || this.initSegment || this.stopped) return;
      this.logInitTimeout();
      killChild(child, 'initialization timeout');
    }, this.initTimeoutMs);
    this.initTimer.unref?.();
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => this.consumeStats(text));
    child.once('error', (error) => {
      this.emit('error', {
        code: error.code === 'ENOENT' ? 'FFMPEG_MISSING' : 'STREAM_FAILED',
        message: error.code === 'ENOENT' ? 'ffmpeg was not found on the server PATH.' : 'The video stream could not be started.',
      });
    });
    child.once('close', (code, signal) => {
      children.delete(child);
      this.flushStderr();
      clearTimeout(this.initTimer);
      this.initTimer = null;
      if (this.child === child) this.child = null;
      if (!this.stopped) this.onUnexpectedExit(code, signal);
    });
  }

  consume(chunk) {
    this.parserBuffer = this.parserBuffer.length ? Buffer.concat([this.parserBuffer, chunk]) : chunk;
    try {
      while (true) {
        const box = readBox(this.parserBuffer);
        if (!box) break;
        const data = this.parserBuffer.subarray(0, box.size);
        this.parserBuffer = this.parserBuffer.subarray(box.size);
        if (!this.initSegment) {
          if (box.type === 'ftyp' || box.type === 'moov') this.initBoxes.push(Buffer.from(data));
          if (box.type === 'moov') {
            this.initSegment = Buffer.concat(this.initBoxes);
            this.mime = mimeFromMoov(data, this.info);
            this.info.mime = this.mime;
            const mvex = boxes(boxes(data)[0].body).find((box) => box.type === 'mvex');
            const trex = mvex && boxes(mvex.body).find((box) => box.type === 'trex');
            this.defaultSampleFlags = trex?.body.length >= 24 ? trex.body.readUInt32BE(20) : undefined;
            clearTimeout(this.initTimer);
            this.initTimer = null;
            this.initializedAt = Date.now();
            this.degraded = false;
            this.emit('init', this.initSegment);
          }
        } else if (box.type === 'moof') {
          this.pendingMoof = Buffer.from(data);
        } else if (box.type === 'mdat' && this.pendingMoof) {
          const fragment = Buffer.concat([this.pendingMoof, data]);
          const keyframe = firstSampleIsKeyframe(this.pendingMoof, this.defaultSampleFlags);
          // Carry the verdict on the buffer itself (additive; the event shape is
          // unchanged). Only the pipeline sees the moov's trex defaults, so the
          // relay should trust this over re-parsing the fragment alone.
          fragment.keyframe = keyframe;
          this.pendingMoof = null;
          if (keyframe) {
            this.gopCache = [];
            this.gopBytes = 0;
          }
          if (keyframe || this.gopCache.length) {
            this.gopCache.push(fragment);
            this.gopBytes += fragment.length;
            if (this.gopBytes > MAX_GOP_BYTES || this.gopCache.length > MAX_GOP_FRAGMENTS) {
              this.gopCache = [];
              this.gopBytes = 0;
            }
          }
          this.emit('fragment', fragment);
        }
      }
    } catch {
      this.emit('error', { code: 'STREAM_FAILED', message: 'ffmpeg produced an invalid MP4 stream.' });
      stopStream(this.streamId);
    }
  }

  consumeStats(text) {
    /* Pipe chunks can split a credentialed URL anywhere, including before @.
     * Scrub complete lines only; discard oversized lines rather than retaining
     * a suffix which could expose the password after a truncation boundary. */
    for (const part of text.split(/(\r\n|\n|\r)/)) {
      if (/^[\r\n]+$/.test(part)) this.flushStderr();
      else if (!this.stderrDiscarding) {
        this.stderrPending += part;
        if (this.stderrPending.length > 8192) {
          this.stderrPending = '';
          this.stderrDiscarding = true;
        }
      }
    }
    const fpsMatches = [...text.matchAll(/fps=\s*([\d.]+)/g)];
    const bitrateMatches = [...text.matchAll(/bitrate=\s*([\d.]+)kbits\/s/g)];
    if (fpsMatches.length) this.stats.fps = Number(fpsMatches.at(-1)[1]);
    if (bitrateMatches.length) this.stats.bitrateKbps = Number(bitrateMatches.at(-1)[1]);
    const now = Date.now();
    if (now - this.lastStatsAt >= 1_000 && (fpsMatches.length || bitrateMatches.length)) {
      this.lastStatsAt = now;
      this.emit('stats', { ...this.stats });
    }
  }

  flushStderr() {
    const line = this.stderrPending;
    if (!this.stderrDiscarding && line.trim() && !/^frame=|^\s*size=/.test(line)) {
      this.stderrTail.push(scrubCredentials(line).slice(0, 300));
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
    }
    this.stderrPending = '';
    this.stderrDiscarding = false;
  }

  logInitTimeout() {
    /* Keep an incomplete line intact until close: a final stderr chunk may
     * still finish its credentialed URL after the timeout fires. */
    console.warn(`[stream] no init segment within ${this.initTimeoutMs / 1000}s for ${this.describe()}; last output:\n`
      + (this.stderrTail.length ? this.stderrTail.map((line) => `    ${line}`).join('\n') : '    (none)'));
  }

  describe() {
    const v = this.profile.video ?? {};
    /* Some vendors also put authentication in query parameters. */
    const endpoint = redactUri(this.profile.rtspUri)?.split(/[?#]/, 1)[0] ?? '(no uri)';
    return `${endpoint} [${this.profile.token}: ${v.codec ?? '?'} ${v.width ?? '?'}x${v.height ?? '?'}@${v.fps ?? '?'}]`;
  }

  logExit(code, signal) {
    console.warn(`[stream] ffmpeg exited (${code !== null ? `code ${code}` : signal ?? 'unknown'}) for ${this.describe()}`
      + `${this.initSegment ? '' : ' before producing an init segment'}; last output:\n`
      + (this.stderrTail.length ? this.stderrTail.map((l) => `    ${l}`).join('\n') : '    (none)'));
  }

  onUnexpectedExit(code, signal) {
    this.logExit(code, signal);
    const healthy = this.initializedAt !== null && Date.now() - this.initializedAt >= HEALTHY_RUN_MS;
    this.failures = healthy ? 0 : this.failures + 1;
    if (this.failures >= 3 && !this.degraded) {
      this.degraded = true;
      this.emit('degraded', { reason: 'ffmpeg failed to stay live 3 times', fallback: 'snapshot' });
    }
    /* A healthy run resets the failure streak. Once degraded, keep probing at
     * a slower cadence while viewers remain; a fresh init re-primes their MSE.
     * Positive jitter avoids reconnect storms without exceeding the 15s cap. */
    const base = this.degraded ? 20_000 : Math.min(15_000, 1_000 * (2 ** Math.max(0, this.failures - 1)));
    const delay = this.degraded ? base + Math.floor(Math.random() * 2_000)
      : Math.min(15_000, base + Math.floor(Math.random() * base * 0.2));
    if (this.stopped) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    this.restartTimer.unref?.();
    if (!healthy && !this.degraded) this.emit('error', {
      code: 'STREAM_FAILED',
      message: `The video stream stopped unexpectedly${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}; retrying.`,
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.initTimer);
    this.initTimer = null;
    this.gopCache = [];
    this.gopBytes = 0;
    clearTimeout(this.orphanTimer);
    this.restartTimer = null;
    this.orphanTimer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      killChild(child, 'stream teardown');
    }
    this.emit('close');
    this.removeAllListeners();
  }
}

export async function startStream(session, profileToken) {
  const profile = session.profileMap.get(profileToken);
  if (!profile?.rtspUri) {
    throw new AppError('UNSUPPORTED', 'That profile does not expose an RTSP stream.',
      'On a Hikvision NVR, confirm the channel is online and the ONVIF user is allowed to view it.');
  }
  const handle = new StreamHandle(session, profile);
  streams.set(handle.streamId, handle);

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      handle.logInitTimeout();
      rejectStream('Timed out waiting for ffmpeg to initialize the stream.');
    }, handle.initTimeoutMs);
    timeout.unref?.();
    const cleanup = () => {
      clearTimeout(timeout);
      handle.off('init', onInit);
      handle.off('error', onError);
      handle.off('degraded', onDegraded);
    };
    const rejectStream = (message, code = 'STREAM_FAILED') => {
      cleanup();
      stopStream(handle.streamId);
      reject(new AppError(code, message, code === 'FFMPEG_MISSING'
        ? 'Install ffmpeg (on macOS: brew install ffmpeg) or set FFMPEG_PATH, then restart the server.'
        : 'Check that the camera is reachable over RTSP on port 554 and that the ONVIF user may view this channel.'));
    };
    const onInit = () => {
      cleanup();
      // A successful start whose client never opens its socket must not orphan
      // ffmpeg indefinitely.
      handle.orphanTimer = setTimeout(() => {
        if (handle.viewers === 0) stopStream(handle.streamId);
      }, 15_000);
      handle.orphanTimer.unref?.();
      resolve({ ...handle.info });
    };
    const onError = (detail) => {
      if (!handle.initSegment && detail.code === 'FFMPEG_MISSING') rejectStream(detail.message, detail.code);
    };
    const onDegraded = (detail) => rejectStream(detail.reason);
    handle.once('init', onInit);
    handle.on('error', onError);
    handle.once('degraded', onDegraded);
  });
  handle.spawn();
  return ready;
}

export function stopStream(streamId) {
  const handle = streams.get(streamId);
  if (!handle) return;
  streams.delete(streamId);
  handle.stop();
}

export function getStream(streamId) {
  return streams.get(streamId);
}

/**
 * Rebuild every live stream for a profile after its encoder configuration changed.
 *
 * A resolution or codec change invalidates the running pipeline in a way that is
 * invisible from the socket: ffmpeg keeps producing fragments, the WebSocket
 * stays open, and the browser's SourceBuffer silently rejects everything because
 * the init segment it was primed with no longer describes the incoming data. The
 * video freezes on the last good frame while every health signal says fine.
 *
 * So the pipeline must be torn down and rebuilt, and the client must be told to
 * re-prime MSE from a fresh init segment. Each affected stream is closed with
 * code 4003, which the player treats as "reconnect and start over" rather than
 * as a fatal error.
 */
export function restartStreamsForProfile(sessionId, profileToken) {
  const affected = [];
  for (const [streamId, handle] of streams) {
    if (handle.sessionId === sessionId && handle.profile?.token === profileToken) {
      affected.push(streamId);
    }
  }
  for (const streamId of affected) {
    const handle = streams.get(streamId);
    if (!handle) continue;
    // Tell viewers to reconnect BEFORE tearing down, so the close reason is
    // distinguishable from an ordinary failure.
    handle.emit('reconfigured', { reason: 'encoder-changed', profile: profileToken });
    stopStream(streamId);
  }
  return affected.length;
}

/** Is any stream currently running for this profile? */
export function hasLiveStreamForProfile(sessionId, profileToken) {
  for (const handle of streams.values()) {
    if (handle.sessionId === sessionId && handle.profile?.token === profileToken) return true;
  }
  return false;
}

export function stopAllForSession(sessionId) {
  for (const [streamId, handle] of streams) {
    if (handle.sessionId === sessionId) {
      handle.sessionEnded = true;
      stopStream(streamId);
    }
  }
}

// Signal listeners run before core's graceful shutdown handlers. The monitor
// hook observes fatal exceptions without changing Node's normal crash behavior.
process.prependListener('SIGINT', () => killAllChildren('SIGINT'));
process.prependListener('SIGTERM', () => killAllChildren('SIGTERM'));
process.on('uncaughtExceptionMonitor', () => killAllChildren('uncaught exception'));
process.once('exit', () => killAllChildren('process exit'));
