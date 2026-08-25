/**
 * Bridge between an encoder configuration change and the live video pipeline.
 *
 * Kept separate from the encoder routes so the ONVIF layer never has to know
 * about ffmpeg, and separate from pipeline.js so the pipeline never has to know
 * about ONVIF. The route calls this after a successful write.
 */
import { restartStreamsForProfile, hasLiveStreamForProfile } from './pipeline.js';

/** Is a rebuild needed for this profile right now? */
export function willDisruptStream(sessionId, profileToken) {
  return hasLiveStreamForProfile(sessionId, profileToken);
}

/**
 * Which encoder fields actually invalidate a running pipeline.
 *
 * Resolution and codec change the init segment, so the browser's SourceBuffer
 * must be rebuilt. Bitrate and GOP length do not — forcing a visible restart for
 * a bitrate nudge would be a worse experience than leaving the stream alone.
 */
const DISRUPTIVE_FIELDS = new Set(['width', 'height', 'encoding']);

export function isDisruptiveChange(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return Object.keys(patch).some((key) => DISRUPTIVE_FIELDS.has(key));
}

/**
 * Rebuild the pipeline for a profile whose encoder changed.
 * @returns {number} how many live streams were restarted
 */
export function reconfigureStreams(sessionId, profileToken, patch) {
  if (!isDisruptiveChange(patch)) return 0;
  return restartStreamsForProfile(sessionId, profileToken);
}
