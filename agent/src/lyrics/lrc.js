'use strict';

/**
 * LRC parser.
 *
 * LRC is the de-facto format for time-synced lyrics:
 *   [00:12.34]First line
 *   [01:02.50][02:14.00]A line that repeats (chorus)
 *   [ar:Artist]           <- metadata, ignored here
 *
 * A single line may carry several timestamps (repeated choruses), which is why
 * the parser expands rather than maps one-to-one.
 */

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

/**
 * @param {string} text raw .lrc content
 * @returns {Array<{ time: number, text: string }>} sorted by time, seconds
 */
function parseLrc(text) {
  if (typeof text !== 'string' || !text.trim()) return [];

  /** @type {Array<{ time: number, text: string }>} */
  const entries = [];

  for (const rawLine of text.split(/\r?\n/)) {
    TIMESTAMP.lastIndex = 0;

    const times = [];
    let match;
    let end = 0;
    while ((match = TIMESTAMP.exec(rawLine)) !== null) {
      // Only leading timestamps count. `[01:00]foo [02:00]bar` is one line whose
      // second bracket is lyric content, not a cue.
      if (match.index !== end) break;
      end = TIMESTAMP.lastIndex;

      const minutes = Number(match[1]);
      const seconds = Number(match[2].replace(':', '.'));
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      times.push(minutes * 60 + seconds);
    }

    if (!times.length) continue;

    const content = rawLine.slice(end).trim();
    for (const time of times) entries.push({ time, text: content });
  }

  entries.sort((a, b) => a.time - b.time);
  return entries;
}

/**
 * Current lyric line for a playback position.
 *
 * Returns null while a gap is "too long" — during an intro or instrumental
 * break we would otherwise leave a stale line frozen on the profile for a
 * minute, which reads as broken.
 *
 * @param {Array<{ time: number, text: string }>} lines
 * @param {number} position seconds
 * @param {{ offset?: number, maxHoldSeconds?: number }} [options]
 * @returns {{ text: string, time: number, index: number, next: number|null }|null}
 */
function lineAt(lines, position, options = {}) {
  if (!Array.isArray(lines) || !lines.length) return null;

  const offset = options.offset ?? 0;
  const maxHold = options.maxHoldSeconds ?? 12;
  const target = position + offset;

  const index = lastIndexAtOrBefore(lines, target);
  if (index < 0) return null;

  const current = lines[index];
  const next = index + 1 < lines.length ? lines[index + 1].time : null;

  // Blank LRC entries are deliberate instrumental markers — honour them.
  if (!current.text) return null;

  const heldFor = target - current.time;
  const gap = next != null ? next - current.time : Infinity;
  if (heldFor > maxHold && gap > maxHold) return null;

  return { text: current.text, time: current.time, index, next };
}

/**
 * When the next line starts, in track seconds, or null at the end.
 *
 * This is what makes accurate timing possible at all: knowing the upcoming
 * boundary lets the presence scheduler spend its scarce update budget exactly
 * when the line changes, instead of whenever the rate limiter happens to open.
 *
 * @param {Array<{ time: number, text: string }>} lines
 * @param {number} position seconds
 * @returns {number|null}
 */
function nextLineTime(lines, position) {
  if (!Array.isArray(lines) || !lines.length) return null;

  const index = lastIndexAtOrBefore(lines, position);
  const next = index + 1;
  return next < lines.length ? lines[next].time : null;
}

/**
 * The lyric text to show in one update, plus when it next needs replacing.
 *
 * Discord grants roughly one update every four seconds, but fast tracks change
 * lines every two — so half the lyrics would never appear at all. When the
 * lines that fall inside a single update's reach are short enough to fit
 * together, they can share one update instead of one being dropped.
 *
 * Nothing is ever shortened: a line either fits whole or is left for the next
 * update. Merging also stops at a blank cue, because that marks deliberate
 * silence and joining across it would glue together text from either side of an
 * instrumental break.
 *
 * @param {Array<{ time: number, text: string }>} lines
 * @param {number} position seconds
 * @param {object} [options]
 * @param {number} [options.offset] manual trim, seconds
 * @param {number} [options.windowSeconds] how far ahead one update must cover;
 *   0 disables merging entirely
 * @param {number} [options.maxChars] hard character budget for the result
 * @param {string} [options.separator] joins merged lines
 * @param {number} [options.maxHoldSeconds] see lineAt
 * @returns {{ text: string|null, nextTime: number|null }} `nextTime` is the cue
 *   of the first line NOT included — what the scheduler should aim at next.
 */
function lyricWindow(lines, position, options = {}) {
  const {
    offset = 0,
    windowSeconds = 0,
    maxChars = Infinity,
    separator = ' · ',
    maxHoldSeconds = 12,
  } = options;

  const target = position + offset;
  const current = lineAt(lines, position, { offset, maxHoldSeconds });

  if (!current) {
    return { text: null, nextTime: nextLineTime(lines, target) };
  }

  const picked = [current.text];
  let length = current.text.length;
  let index = current.index;

  while (index + 1 < lines.length) {
    const candidate = lines[index + 1];

    if (candidate.time >= target + windowSeconds) break; // beyond this update's reach
    if (!candidate.text) break; // instrumental marker — do not merge across it

    const cost = separator.length + candidate.text.length;
    if (length + cost > maxChars) break; // would require cutting, so leave it

    picked.push(candidate.text);
    length += cost;
    index += 1;
  }

  return {
    text: picked.join(separator),
    nextTime: index + 1 < lines.length ? lines[index + 1].time : null,
  };
}

/**
 * Pack the whole song into blocks of a few lines each.
 *
 * The line-at-a-time mode spends one Discord update per lyric line, and Discord
 * only grants five per twenty seconds — so a talkative song burns the entire
 * budget on text nobody reads twice. A block instead shows several lines at
 * once and stands until its last line has been sung, which costs one update per
 * *paragraph* rather than per line.
 *
 * Blocks are derived from the timings alone, so the same song always breaks in
 * the same places: no flicker when the position is re-anchored, and the
 * scheduler can aim at the next block exactly as it aimed at the next line.
 *
 * A blank cue ends a block, because an instrumental break is a natural pause
 * and joining across it would glue unrelated verses together.
 *
 * @param {Array<{ time: number, text: string }>} lines
 * @param {object} [options]
 * @param {number} [options.maxChars] character budget for one block
 * @param {string} [options.separator] joins lines inside a block
 * @returns {Array<{ start: number, end: number, text: string, lines: number }>}
 */
function buildBlocks(lines, options = {}) {
  const { maxChars = 120, separator = ' · ' } = options;
  if (!Array.isArray(lines) || !lines.length) return [];

  const packed = [];
  let current = null;

  const flush = () => {
    if (current) packed.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!line.text) {
      flush(); // deliberate silence: let the block end here
      continue;
    }

    if (!current) {
      current = { start: line.time, texts: [line.text], length: line.text.length };
      continue;
    }

    const cost = separator.length + line.text.length;
    if (current.length + cost > maxChars) {
      flush();
      current = { start: line.time, texts: [line.text], length: line.text.length };
    } else {
      current.texts.push(line.text);
      current.length += cost;
    }
  }
  flush();

  return packed.map((block, index) => ({
    start: block.start,
    // A block stands until the next one begins; the last one until the song ends.
    end: index + 1 < packed.length ? packed[index + 1].start : Infinity,
    text: block.texts.join(separator),
    lines: block.texts.length,
  }));
}

/**
 * The block covering this position, or null before the first one.
 *
 * @param {ReturnType<typeof buildBlocks>} blocks
 * @param {number} position seconds
 * @param {object} [options]
 * @param {number} [options.offset] manual trim, seconds
 * @returns {{ text: string, start: number, end: number, lines: number }|null}
 */
function blockAt(blocks, position, options = {}) {
  const { offset = 0 } = options;
  if (!Array.isArray(blocks) || !blocks.length) return null;

  const target = position + offset;
  let low = 0;
  let high = blocks.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].start <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return found === -1 ? null : blocks[found];
}

/** Binary search: index of the last entry with time <= target, or -1. */
function lastIndexAtOrBefore(lines, target) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

module.exports = { parseLrc, lineAt, nextLineTime, lyricWindow, buildBlocks, blockAt };
