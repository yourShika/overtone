'use strict';

/**
 * What a surface is allowed to know.
 *
 * A hand-written allowlist, and deliberately not a spread of statusSnapshot()
 * with a few fields deleted. That snapshot carries `discordUser`, `lastError`,
 * the transcription queue and the watch list — none of which belongs on
 * somebody's stream, and all of which would arrive automatically the day a new
 * field is added to it. Written this way round, a new field reaches a surface
 * only when somebody puts it here on purpose.
 *
 * Pure: given a snapshot and a config it returns an object. No sockets, no
 * clock beyond the one passed in, so every rule below can be tested.
 */

/** Long enough for any real title; short enough that nothing can flood a page. */
const MAX_TEXT = 200;
const MAX_LINE = 300;
/** A whole song's worth of cues, but not a transcript of a podcast. */
const MAX_CUES = 400;

/**
 * Build the object a surface receives.
 *
 * @param {object} params
 * @param {object|null} params.snapshot  statusSnapshot()
 * @param {object} params.config         the app's settings
 * @param {Array|null} params.lines      parsed cues for the current track
 * @param {number} params.now            epoch ms, injected so tests can hold it
 * @returns {object}
 */
function overlayPayload({ snapshot, config, lines, now }) {
  const state = snapshot?.now || null;

  // Nothing playing is a state a surface has to render, not an error.
  if (!state) {
    return { playing: false, paused: false, privacy: false, mode: 'none', at: now };
  }

  // Private mode reaches the overlay exactly as it reaches Discord. Someone who
  // hid the title from three friends did not mean to show it to a stream.
  if (config.privacyMode) {
    return {
      playing: true,
      paused: Boolean(state.paused),
      privacy: true,
      mode: 'none',
      duration: seconds(state.duration),
      position: seconds(state.position),
      at: now,
    };
  }

  const lyrics = snapshot?.lyrics || {};
  const wanted =
    config.lyricsEnabled !== false &&
    !(config.lyricsMusicOnly && state.source !== 'ytmusic');

  return {
    playing: true,
    paused: Boolean(state.paused),
    privacy: false,

    title: text(state.title),
    artist: text(state.artist),
    // Only the two hosts the settings window already allows, so a surface's CSP
    // can name them and a manifest cannot smuggle in a third.
    cover: artwork(state.thumbnail),
    /**
     * The video's own id, for a surface that shows the video rather than words
     * about it.
     *
     * Shaped rather than trusted: eleven of YouTube's id characters and nothing
     * else, because a page will paste this into an embed address. It carries no
     * more than the title and the artwork already here — and like them it is
     * absent in private mode, which returns above this point.
     */
    video: /^[\w-]{11}$/.test(String(state.videoId || '')) ? String(state.videoId) : '',
    source: state.source === 'ytmusic' ? 'ytmusic' : 'youtube',

    duration: seconds(state.duration),
    /**
     * Where the song was at `at`, not where it is now.
     *
     * The page runs its own clock from this anchor, so one message per change
     * keeps a progress bar and a lyric frame-accurate for minutes. Streaming
     * the position instead would mean a message a second and a bar that still
     * stepped rather than moved.
     */
    position: seconds(state.position),
    at: now,

    ...lyricsPart(lyrics, lines, wanted),
  };
}

/**
 * The lyric half, in one of three shapes.
 *
 * 'timed' carries the whole cue list once, so the page can look ahead and the
 * next line is already there when the current one ends. 'caption' carries a
 * single line because YouTube's subtitles arrive one at a time and there is
 * nothing to look ahead at — the page must stop predicting rather than guess.
 */
function lyricsPart(lyrics, lines, wanted) {
  if (!wanted) return { mode: 'none' };

  if (Array.isArray(lines) && lines.length) {
    return {
      mode: 'timed',
      cues: lines.slice(0, MAX_CUES).map((cue) => ({
        t: seconds(cue.time),
        text: String(cue.text || '').slice(0, MAX_LINE),
      })),
    };
  }

  if (lyrics.status === 'captions' || lyrics.origin === 'captions') {
    return { mode: 'caption', line: String(lyrics.line || '').slice(0, MAX_LINE) };
  }

  return { mode: 'none' };
}

function text(value) {
  return String(value || '').slice(0, MAX_TEXT);
}

/** Rounded to whole seconds: a surface has no use for more, and it is smaller. */
function seconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

/** Only the artwork hosts the rest of the app already trusts. */
function artwork(url) {
  const value = String(url || '');
  return /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\//.test(value) ? value : '';
}

/**
 * Whether two payloads differ in a way a page would notice.
 *
 * The tick fires several times a second while a lyric moves; the position
 * changes every time and the page does not care, because it has the anchor. So
 * the position is compared loosely and everything else exactly.
 */
function changed(previous, next) {
  if (!previous) return true;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    if (key === 'at') continue;
    if (key === 'position') {
      // A seek, not the song simply advancing between two messages.
      if (Math.abs((next.position || 0) - drift(previous, next)) > 2) return true;
      continue;
    }
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) return true;
  }
  return false;
}

/** Where the previous anchor says the song should be by now. */
function drift(previous, next) {
  if (previous.paused) return previous.position || 0;
  return (previous.position || 0) + ((next.at || 0) - (previous.at || 0)) / 1000;
}

module.exports = { overlayPayload, changed, MAX_TEXT, MAX_LINE, MAX_CUES };
