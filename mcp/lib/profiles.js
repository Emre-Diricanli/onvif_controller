/**
 * Which media profile a tool acts on (shared by get_snapshot and PTZ).
 *
 * A profile token is not a channel (ADAPTERS.md §2): channels resolve through
 * the session's sources, never by matching numbers. An explicit profile wins
 * and must exist; a 1-based channel maps to that channel's first profile.
 * With neither, `guessOnMultiChannel` decides: a read (a snapshot) may default
 * to the first stream, but an action that moves hardware (PTZ) must not guess
 * which camera on a recorder it is about to move.
 */
import { ToolError } from './kit.js';

export function resolveProfile(session, { profile, channel } = {}, { guessOnMultiChannel = false, preferSnapshot = false } = {}) {
  const sources = Array.isArray(session?.sources) ? session.sources : [];
  const profiles = Array.isArray(session?.profiles) ? session.profiles : [];

  if (typeof profile === 'string' && profile.trim()) {
    const token = profile.trim();
    if (profiles.length && !profiles.some((p) => p.token === token)) {
      throw new ToolError('NOT_FOUND', `No media profile "${token}" on this device.`, `Known profiles: ${profiles.map((p) => p.token).join(', ')}.`);
    }
    return { token, channel: null };
  }

  if (channel !== undefined && channel !== null) {
    const idx = Number(channel) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= sources.length) {
      throw new ToolError('BAD_REQUEST', `No channel ${channel} on this device (it reports ${sources.length}).`,
        'Pass a valid 1-based channel (see list_targets or device_info).');
    }
    const token = sources[idx]?.profiles?.[0]?.token;
    if (!token) throw new ToolError('BAD_REQUEST', `Channel ${channel} exposes no media profile.`, 'Pick a profile token from device_info instead.');
    return { token, channel: Number(channel) };
  }

  const singleChannel = !session?.isMultiChannel || sources.length === 1;
  if (singleChannel || guessOnMultiChannel) {
    const pick = (preferSnapshot && profiles.find((p) => p.snapshotSupported !== false)) || profiles[0];
    if (pick?.token) return { token: pick.token, channel: null };
  }
  throw new ToolError('BAD_REQUEST',
    'This device has multiple channels, so this call needs `profile` (a token from device_info) or `channel` (1-based).',
    'Call device_info or list_targets to see the channels.');
}
