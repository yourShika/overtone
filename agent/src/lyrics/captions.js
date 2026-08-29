'use strict';

/**
 * Tidying YouTube's subtitle lines.
 *
 * Auto-generated captions describe what they hear, not only what is said. On a
 * music video that means whole lines reading `[Musik]`, `[Applaus]`,
 * `[Gelächter]` — correct as a transcript, useless as a lyric, and on a stream
 * overlay it is the one thing viewers read while the song plays.
 *
 * Pure: strings in, strings out. No config, no state, so every rule below can
 * be checked directly.
 */

/**
 * Strip the sound-event markers out of a subtitle line.
 *
 * Matched by *shape*, not by word. YouTube writes non-speech events in square
 * brackets in every language it generates for — `[Musik]`, `[Music]`,
 * `[Aplausos]`, `[музыка]`, `[音楽]` — so the bracket is the signal, and a word
 * list would only ever cover the handful of languages this app is translated
 * into while failing silently on the rest.
 *
 * Parentheses are deliberately left alone. Manual caption tracks and real
 * lyrics both use them for backing vocals — "(ooh, ooh)" is part of the song,
 * and dropping it would be a worse mistake than keeping a stray "(Musik)".
 *
 * @param {string} input the line as YouTube rendered it
 * @returns {string} the line with the markers gone; '' when that is all it was
 */
function cleanCaption(input) {
  const text = String(input || '')
    // [Musik], [Applaus], [Verse 1], [?] — and any of them repeated.
    .replace(/\[[^\]]*\]/g, ' ')
    // Music notes bracket singing on manual tracks: ♪ Never gonna give ♪.
    .replace(/[♪♫🎵🎶]+/g, ' ')
    // '>>' introduces a new speaker on broadcast-style tracks.
    .replace(/(^|\s)>>+\s*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Punctuation left standing alone once its sentence was a sound event: a line
  // that has become "-" or "..." is not something to put on a stream.
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

/**
 * Whether a line is nothing but sound events.
 *
 * Used to tell "captions are on and the song is instrumental" apart from
 * "captions are off", which look identical once the markers are gone.
 */
function isNoiseOnly(input) {
  const raw = String(input || '').trim();
  return Boolean(raw) && !cleanCaption(raw);
}

module.exports = { cleanCaption, isNoiseOnly };
