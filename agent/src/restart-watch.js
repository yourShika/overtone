'use strict';

/**
 * Notices a YouTube player that keeps restarting the same video.
 *
 * This is the one fault the tab watchdog cannot see. Its rule is twelve
 * seconds of frozen playback with readyState below 2 — but a pipeline that
 * tears itself down and builds itself back up looks perfectly healthy at every
 * instant it is asked. What gives it away is the repetition: the same title
 * announced over and over, which is how a user spotted it in their own log
 * before any code did.
 *
 * Kept out of main.js and free of Electron for the same reason watchdog.js is:
 * a rule that decides when to shout at somebody should be exercisable in a
 * test, including the cases where it must stay quiet.
 */

/** Resumptions further apart than this are two ordinary reconnects, not a loop. */
const WINDOW_MS = 300000;

/**
 * Resumptions before the pattern counts as a diagnosis.
 *
 * Three rather than two: a browser that drops its socket once and reconnects
 * produces one, and an MV3 worker eviction during a long song can produce a
 * second, so two is still comfortably explicable.
 */
const THRESHOLD = 3;

class RestartWatch {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs]
   * @param {number} [options.threshold]
   * @param {() => number} [options.now] injectable clock, for tests
   */
  constructor({ windowMs = WINDOW_MS, threshold = THRESHOLD, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.now = now;
    /** @type {Map<string, {count: number, since: number, warned: boolean}>} */
    this.runs = new Map();
  }

  /**
   * Count one resumption of `videoId`.
   *
   * @returns {boolean} true exactly once per run, when the count first reaches
   *   the threshold. Repeating the warning for every resumption after that
   *   would reproduce the very noise this exists to explain.
   */
  resumed(videoId) {
    if (!videoId) return false;

    const now = this.now();
    const run = this.runs.get(videoId);

    if (!run || now - run.since > this.windowMs) {
      this.runs.set(videoId, { count: 1, since: now, warned: false });
      return false;
    }

    run.count += 1;
    if (run.count < this.threshold || run.warned) return false;

    run.warned = true;
    return true;
  }

  /** A track that genuinely changed ends whatever run it was in. */
  settled(videoId) {
    if (videoId) this.runs.delete(videoId);
  }

  /** How many resumptions the current run holds, for the status snapshot. */
  countFor(videoId) {
    const run = this.runs.get(videoId);
    if (!run || this.now() - run.since > this.windowMs) return 0;
    return run.count;
  }
}

module.exports = { RestartWatch, WINDOW_MS, THRESHOLD };
