'use strict';

/**
 * Playback session.
 *
 * The extension reports a snapshot every few seconds, not every frame. For
 * lyrics we need the position to sub-second accuracy, so the session stores the
 * last reported position plus the wall-clock time it arrived, and extrapolates
 * forward from there. A fresh report resets the anchor, so drift never
 * accumulates across reports.
 */

/** A snapshot older than this means the tab died without telling us. */
const STALE_AFTER_MS = 20000;

class Session {
  constructor() {
    /** @type {object|null} */
    this.raw = null;
    this.receivedAt = 0;
  }

  /**
   * @param {object} snapshot payload from the extension bridge
   * @returns {{ trackChanged: boolean, pausedChanged: boolean, seeked: boolean }}
   */
  update(snapshot) {
    const previous = this.raw;
    const previousPosition = previous ? this.position : null;

    this.raw = normalise(snapshot);
    this.receivedAt = Date.now();

    return {
      trackChanged: previous?.id !== this.raw.id,
      pausedChanged: previous?.paused !== this.raw.paused,
      seeked:
        previous?.id === this.raw.id &&
        previousPosition != null &&
        Math.abs(previousPosition - this.raw.position) > 2,
    };
  }

  clear() {
    this.raw = null;
    this.receivedAt = 0;
  }

  get active() {
    return this.raw !== null && !this.isStale();
  }

  isStale(maxAgeMs = STALE_AFTER_MS) {
    if (!this.raw) return true;
    return Date.now() - this.receivedAt > maxAgeMs;
  }

  /** Interpolated playback position in seconds. */
  get position() {
    if (!this.raw) return 0;
    if (this.raw.paused) return this.raw.position;

    const elapsed = (Date.now() - this.receivedAt) / 1000;
    const projected = this.raw.position + elapsed * (this.raw.playbackRate || 1);

    if (this.raw.live || !Number.isFinite(this.raw.duration) || this.raw.duration <= 0) {
      return Math.max(0, projected);
    }
    return Math.min(this.raw.duration, Math.max(0, projected));
  }

  /** Snapshot with the position advanced to *now*, ready to hand to a builder. */
  get state() {
    if (!this.raw) return null;
    return { ...this.raw, position: this.position };
  }
}

/**
 * Coerce whatever the extension sent into the shape the rest of the agent
 * expects. Everything downstream may assume these fields exist and have the
 * right type.
 */
function normalise(snapshot) {
  const source = snapshot.source === 'ytmusic' ? 'ytmusic' : 'youtube';
  const videoId = str(snapshot.videoId);

  return {
    id: `${source}:${videoId || str(snapshot.title)}`,
    source,
    videoId,
    title: str(snapshot.title),
    artist: str(snapshot.artist),
    album: str(snapshot.album),
    channel: str(snapshot.channel),
    channelUrl: str(snapshot.channelUrl) || null,
    url: str(snapshot.url) || (videoId ? `https://youtu.be/${videoId}` : ''),
    thumbnail: str(snapshot.thumbnail) || null,
    duration: num(snapshot.duration, 0),
    position: Math.max(0, num(snapshot.position, 0)),
    playbackRate: num(snapshot.playbackRate, 1) || 1,
    paused: Boolean(snapshot.paused),
    live: Boolean(snapshot.live),
    /** The track will repeat; shown as a badge rather than in the text. */
    loop: Boolean(snapshot.loop),
    /** No playback at all — a YouTube tab is simply open and in front. */
    idle: Boolean(snapshot.idle),
    /** Which kind of page, when idle: home, search, channel, … */
    page: str(snapshot.page),
    /** Media-pipeline trouble the page reported; null while healthy. */
    fault: snapshot.fault && typeof snapshot.fault === 'object' ? snapshot.fault : null,
    /** Subtitle line YouTube is rendering right now; '' when captions are off. */
    caption: str(snapshot.caption),
    captionTrack: str(snapshot.captionTrack),
    /**
     * Whether the content script that produced this snapshot knows about
     * captions at all.
     *
     * This is the honest capability signal, and it has to come from the
     * snapshot rather than the extension's `hello`: MV3 service workers are
     * re-read from disk every time they wake, so the worker is always current,
     * while content scripts stay frozen in whatever tab was already open when
     * the files changed. An outdated probe simply omits the key — so a missing
     * `caption` means "cannot", and '' means "can, but subtitles are off".
     */
    captionCapable: Object.prototype.hasOwnProperty.call(snapshot, 'caption'),
  };
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = { Session, STALE_AFTER_MS };
