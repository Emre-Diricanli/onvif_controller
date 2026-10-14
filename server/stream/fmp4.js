/**
 * Minimal fragmented-MP4 (ISO BMFF) parsing for the live relay.
 *
 * ffmpeg cuts fragments on `-frag_duration` (200ms), NOT on keyframes, so a
 * fragment dropped mid-GOP leaves the browser's decoder without a reference
 * frame until the next keyframe — visible smear or freeze. To drop video under
 * backpressure without corrupting the picture, the relay must know which
 * fragments START a GOP. That lives in the sample flags of the first sample:
 *
 *   moof > traf > trun.first_sample_flags   (trun flags & 0x000004)
 *   moof > traf > trun per-sample flags[0]  (trun flags & 0x000400)
 *   moof > traf > tfhd.default_sample_flags (tfhd flags & 0x000020)
 *
 * checked in that precedence, per ISO 14496-12 §8.8.3. A 32-bit sample flags
 * word carries `sample_depends_on` in bits 25-24 (2 = I-picture) and
 * `sample_is_non_sync_sample` in bit 16 (0 = random-access point).
 */

/** Read a box header at `offset`; null when truncated or invalid. Never throws. */
function readBoxHeader(buffer, offset) {
  const remaining = buffer.length - offset;
  if (remaining < 8) return null;
  let size = buffer.readUInt32BE(offset);
  let headerSize = 8;
  if (size === 1) {
    // 64-bit largesize. mdat uses it past 4 GiB; a moof never will, but the
    // scan must still step over one correctly.
    if (remaining < 16) return null;
    const large = buffer.readBigUInt64BE(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    return null; // "to end of file" — cannot appear in a piped fragment
  }
  if (size < headerSize || remaining < size) return null;
  return { type: buffer.toString('ascii', offset + 4, offset + 8), size, headerSize };
}

/** tfhd payload -> default_sample_flags, or null when absent/truncated. */
function readTfhdDefaultFlags(buffer, start, end) {
  if (end - start < 8) return null; // version+flags (4) + track_ID (4)
  const flags = buffer.readUInt32BE(start) & 0xffffff;
  let offset = start + 8;
  if (flags & 0x000001) offset += 8; // base-data-offset
  if (flags & 0x000002) offset += 4; // sample-description-index
  if (flags & 0x000008) offset += 4; // default-sample-duration
  if (flags & 0x000010) offset += 4; // default-sample-size
  if (!(flags & 0x000020)) return null; // default-sample-flags absent
  if (end - offset < 4) return null;
  return buffer.readUInt32BE(offset);
}

/** trun payload -> flags word describing sample 0, or null when absent. */
function readTrunFirstSampleFlags(buffer, start, end) {
  if (end - start < 8) return null; // version+flags (4) + sample_count (4)
  const flags = buffer.readUInt32BE(start) & 0xffffff;
  const sampleCount = buffer.readUInt32BE(start + 4);
  let offset = start + 8;
  if (flags & 0x000001) offset += 4; // data-offset
  if (flags & 0x000004) {
    // first_sample_flags overrides everything for sample 0.
    if (end - offset < 4) return null;
    return buffer.readUInt32BE(offset);
  }
  if ((flags & 0x000400) && sampleCount >= 1) {
    // Per-sample records: duration and size precede the flags in each record.
    if (flags & 0x000100) offset += 4;
    if (flags & 0x000200) offset += 4;
    if (end - offset < 4) return null;
    return buffer.readUInt32BE(offset);
  }
  return null;
}

/**
 * One traf -> true/false when its first sample's sync state is determinable,
 * null when the traf carries no sample flags at all.
 */
function readTrafVerdict(buffer, start, end) {
  let defaultFlags = null;
  let runFlags = null;
  let offset = start;
  while (offset < end) {
    const box = readBoxHeader(buffer, offset);
    if (!box) break;
    const payloadStart = offset + box.headerSize;
    const boxEnd = offset + box.size;
    if (box.type === 'tfhd' && defaultFlags === null) {
      defaultFlags = readTfhdDefaultFlags(buffer, payloadStart, boxEnd);
    } else if (box.type === 'trun' && runFlags === null) {
      runFlags = readTrunFirstSampleFlags(buffer, payloadStart, boxEnd);
    }
    offset = boxEnd;
  }
  const flags = runFlags ?? defaultFlags;
  if (flags === null) return null;
  const dependsOn = (flags >>> 24) & 0x3;
  const nonSync = (flags >>> 16) & 0x1;
  return dependsOn === 2 || nonSync === 0;
}

/**
 * Does this moof(+mdat) fragment begin on a keyframe, i.e. is it a safe point
 * for a decoder to start from?
 *
 * Pure and throw-free: it runs per fragment on the relay hot path, so every
 * read is bounds-checked and malformed input degrades instead of exploding.
 *
 * Fallbacks, both deliberate:
 * - No moof box (an init segment, garbage, a truncated read) -> false. It is
 *   provably not a media fragment, so it must never end a keyframe wait.
 * - A moof whose tracks carry no sample flags anywhere -> true. ffmpeg always
 *   writes flags; a muxer that does not is beyond reasoning about, and in skip
 *   mode "cannot prove non-keyframe" must fall back to sending rather than
 *   dropping forever — a skip that can never end is a frozen video with no
 *   recovery path, which is worse than one smeared GOP.
 */
export function isKeyframeFragment(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;

  // Scan top-level boxes for the moof; mdat/styp siblings are irrelevant.
  let offset = 0;
  while (offset < buffer.length) {
    const box = readBoxHeader(buffer, offset);
    if (!box) break;
    const boxEnd = offset + box.size;
    if (box.type === 'moof') {
      // The pipeline strips audio (-an), so there is exactly one traf. Should a
      // muxer ever emit several, the first determinable one decides: ffmpeg
      // orders video first, and "any traf" would misfire because (audio)
      // samples are all sync samples.
      let cursor = offset + box.headerSize;
      while (cursor < boxEnd) {
        const child = readBoxHeader(buffer, cursor);
        if (!child) break;
        if (child.type === 'traf') {
          const verdict = readTrafVerdict(buffer, cursor + child.headerSize, cursor + child.size);
          if (verdict !== null) return verdict;
        }
        cursor += child.size;
      }
      return true; // moof present but no flags anywhere — see fallbacks above
    }
    offset = boxEnd;
  }
  return false; // no moof at all
}
