import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const streams = new Map();
const children = new Set();
const DEFAULT_MIME = 'video/mp4; codecs="avc1.42E01E"';
const FAILURE_WINDOW_MS = 30_000;

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

function findAvcC(buffer, start = 0, end = buffer.length) {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(buffer.subarray(0, end), offset);
    if (!box || offset + box.size > end) break;
    const payloadStart = offset + box.headerSize;
    if (box.type === 'avcC' && box.size >= box.headerSize + 4) {
      return buffer.subarray(payloadStart, offset + box.size);
    }
    // Container boxes used on the path to the AVC sample entry. stsd and avc1
    // have fixed fields before their child boxes.
    const skips = { moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, stsd: 8, avc1: 78, avc3: 78 };
    if (Object.hasOwn(skips, box.type)) {
      const found = findAvcC(buffer, payloadStart + skips[box.type], offset + box.size);
      if (found) return found;
    }
    offset += box.size;
  }
  return null;
}

function mimeFromMoov(moov) {
  try {
    const avcC = findAvcC(moov);
    if (!avcC || avcC.length < 4) return DEFAULT_MIME;
    const codec = `avc1.${[avcC[1], avcC[2], avcC[3]].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return `video/mp4; codecs="${codec}"`;
  } catch {
    return DEFAULT_MIME;
  }
}

class StreamHandle extends EventEmitter {
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
    this.failures = [];
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
    if (this.viewers === 0) stopStream(this.streamId);
  }

  spawn() {
    if (this.stopped) return;
    this.parserBuffer = Buffer.alloc(0);
    this.initBoxes = [];
    this.pendingMoof = null;
    this.initSegment = null;
    const transcode = this.info.transcoding;
    const videoArgs = transcode
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
      : ['-c:v', 'copy'];
    const args = [
      '-hide_banner', '-loglevel', 'info', '-rtsp_transport', 'tcp', '-i', this.profile.rtspUri,
      ...videoArgs, '-an', '-f', 'mp4',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
      '-frag_duration', '200000', 'pipe:1',
    ];
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    children.add(child);
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
            this.mime = mimeFromMoov(data);
            this.info.mime = this.mime;
            this.emit('init', this.initSegment);
          }
        } else if (box.type === 'moof') {
          this.pendingMoof = Buffer.from(data);
        } else if (box.type === 'mdat' && this.pendingMoof) {
          const fragment = Buffer.concat([this.pendingMoof, data]);
          this.pendingMoof = null;
          this.emit('fragment', fragment);
        }
      }
    } catch {
      this.emit('error', { code: 'STREAM_FAILED', message: 'ffmpeg produced an invalid MP4 stream.' });
      stopStream(this.streamId);
    }
  }

  consumeStats(text) {
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

  onUnexpectedExit(code, signal) {
    const now = Date.now();
    this.failures = this.failures.filter((time) => now - time < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= 3) {
      this.degraded = true;
      this.emit('degraded', { reason: 'ffmpeg exited 3 times', fallback: 'snapshot' });
      return;
    }
    const delay = 1_000 * (2 ** (this.failures.length - 1));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
    this.restartTimer.unref?.();
    this.emit('error', {
      code: 'STREAM_FAILED',
      message: `The video stream stopped unexpectedly${code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ''}; retrying.`,
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.orphanTimer);
    this.restartTimer = null;
    this.orphanTimer = null;
    const child = this.child;
    this.child = null;
    if (child) {
      children.delete(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!child.killed) child.kill('SIGKILL');
    }
    this.emit('close');
    this.removeAllListeners();
  }
}

export async function startStream(session, profileToken) {
  const profile = session.profileMap.get(profileToken);
  if (!profile?.rtspUri) {
    const error = new Error('The requested media profile is unavailable.');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const handle = new StreamHandle(session, profile);
  streams.set(handle.streamId, handle);

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => rejectStream('Timed out waiting for ffmpeg to initialize the stream.'), 15_000);
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
      const error = new Error(message);
      error.code = code;
      reject(error);
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

export function stopAllForSession(sessionId) {
  for (const [streamId, handle] of streams) {
    if (handle.sessionId === sessionId) {
      handle.sessionEnded = true;
      stopStream(streamId);
    }
  }
}

process.once('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* Process is already gone. */ }
  }
});
