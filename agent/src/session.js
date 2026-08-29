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
const { stripNoise } = require('./lyrics/trackparse');

const STALE_AFTER_MS = 20000;

/**
 * How long a cleared track stays claimable by the next report.
 *
 * A clear does not always mean the song ended. The extension's MV3 worker is
 * evicted after ~30 s idle and revived by a one-minute alarm, the watchdog
 * reloads a wedged tab, a snapshot simply arrives late — each of those drops the
 * session and the very same track then comes back. Ninety seconds covers the
 * longest gap the plumbing itself produces (the keepalive alarm) with room to
 * spare, while putting the song on again an hour later is still news.
 */
const RESUME_WITHIN_MS = 90000;

class Session {
  constructor() {
    /** @type {object|null} */
    this.raw = null;
    this.receivedAt = 0;
    /**
     * Identity of the last track, kept deliberately across clear().
     *
     * `raw` going null must retract the presence without also erasing what was
     * playing; conflating the two is what made every reconnect read as a new
     * song.
     */
    this.lastId = null;
    this.clearedAt = 0;
  }

  /**
   * @param {object} snapshot payload from the extension bridge
   * @returns {{ trackChanged: boolean, resumed: boolean, pausedChanged: boolean,
   *             captionChanged: boolean, seeked: boolean }}
   */
  update(snapshot) {
    const previous = this.raw;
    const previousPosition = previous ? this.position : null;

    this.raw = normalise(snapshot);
    this.receivedAt = Date.now();

    // With a live snapshot, compare against it. Without one we were cleared, so
    // fall back to what we remember: a returning track is a resumption.
    const known = previous ? previous.id : this.resumableId();

    return {
      trackChanged: known !== this.raw.id,
      /** The same track came back after a clear: a reconnect, not a new song. */
      resumed: !previous && known !== null && known === this.raw.id,
      pausedChanged: previous?.paused !== this.raw.paused,
      /**
       * A new subtitle line arrived.
       *
       * The one lyric the agent cannot work out for itself: timed lyrics are
       * loaded once and read off a clock, but a caption exists only because the
       * page just rendered it. So it needs its own signal — without one it
       * would wait for the next tick, and a line that lasts two seconds would
       * spend half its life being the previous line on somebody's stream.
       */
      captionChanged: (previous?.caption || '') !== (this.raw.caption || ''),
      seeked:
        previous?.id === this.raw.id &&
        previousPosition != null &&
        Math.abs(previousPosition - this.raw.position) > 2,
    };
  }

  clear() {
    if (this.raw) {
      this.lastId = this.raw.id;
      this.clearedAt = Date.now();
    }
    this.raw = null;
    this.receivedAt = 0;
  }

  /**
   * The track a returning report may claim without counting as new, or null
   * once too much time has passed for that to be believable.
   */
  resumableId() {
    if (!this.lastId) return null;
    return Date.now() - this.clearedAt <= RESUME_WITHIN_MS ? this.lastId : null;
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
    // A stalled video advances no further than a paused one. Extrapolating
    // through a buffer would put the presence ahead of what is on screen, and
    // the gap grows for as long as the stall lasts.
    if (this.raw.paused || this.raw.buffering) return this.raw.position;

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

  /**
   * The title as it should be shown, with YouTube's decoration removed.
   *
   * Computed here rather than in each surface so the presence, the settings
   * preview and the tray popup can never disagree about what is playing.
   */
  displayTitle(clean = true) {
    if (!this.raw?.title) return '';
    return clean ? stripNoise(this.raw.title) || this.raw.title : this.raw.title;
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
    /** Waiting for data: neither playing nor paused, and the position is frozen. */
    buffering: Boolean(snapshot.buffering),
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

module.exports = { Session, STALE_AFTER_MS, RESUME_WITHIN_MS };
