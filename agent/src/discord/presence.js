'use strict';

/**
 * Presence controller.
 *
 * Sits between "what we would like Discord to show" and "what Discord actually
 * lets us send". Discord rate-limits SET_ACTIVITY to 5 calls per 20 seconds per
 * client; exceeding that gets the frames silently dropped and, if you keep
 * pushing, the RPC connection closed.
 *
 * Lyrics change every 3-5 seconds, so this limit is the binding constraint of
 * the whole app. The controller therefore:
 *   - keeps only the newest desired activity (intermediate ones are coalesced),
 *   - sends it at the earliest moment the sliding window allows,
 *   - and suppresses updates that are not meaningfully different, so the budget
 *     is spent on real changes instead of timestamp jitter.
 */

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 20000;

/** Timestamps within this tolerance are treated as unchanged (see _differs). */
const TIMESTAMP_TOLERANCE_MS = 2000;

class PresenceController {
  /**
   * @param {import('./ipc').DiscordIPC} ipc
   * @param {{ limit?: number, windowMs?: number, onSend?: Function }} [options]
   */
  constructor(ipc, options = {}) {
    this.ipc = ipc;
    this.limit = options.limit ?? RATE_LIMIT;
    this.windowMs = options.windowMs ?? RATE_WINDOW_MS;
    this.onSend = options.onSend ?? null;

    /** @type {number[]} send timestamps inside the current window */
    this._sends = [];
    /** @type {object|null} what we want Discord to show */
    this._desired = null;
    /** @type {object|null} what Discord is actually showing */
    this._applied = null;
    this._dirty = false;
    this._timer = null;

    /** Average spacing the limit permits — one send per `step` ms. */
    this.step = this.windowMs / this.limit;

    /**
     * Pulled at send time so the payload reflects the moment it is actually
     * transmitted, not the moment something was noticed. Without this, content
     * chosen a second or two earlier goes out stale.
     * @type {(() => object|null)|null}
     */
    this.provider = options.provider ?? null;

    /**
     * Wall-clock ms at which the content is known to change next (the start of
     * the upcoming lyric line). Null when unknown, e.g. for subtitles.
     * @type {number|null}
     */
    this._nextChangeAt = null;

    // A fresh connection has no activity, so whatever we last applied is void.
    ipc.on('connected', () => {
      this._applied = null;
      this._sends = [];
      if (this._desired !== null) {
        this._dirty = true;
        this._schedule();
      }
    });
    ipc.on('disconnected', () => {
      this._applied = null;
      clearTimeout(this._timer);
      this._timer = null;
    });
  }

  /** Late-binding content source; see the `provider` field. */
  setProvider(fn) {
    this.provider = typeof fn === 'function' ? fn : null;
  }

  /**
   * Tell the controller when the content will next change, as a wall-clock
   * timestamp. Enables boundary-aligned sending; pass null when unknown.
   */
  setNextChangeAt(timestamp) {
    this._nextChangeAt = Number.isFinite(timestamp) ? timestamp : null;
  }

  /**
   * Request an activity. Safe to call as often as you like — the controller
   * decides when (and whether) it reaches Discord.
   *
   * @param {object|null} activity pass null to clear the presence
   * @param {{ urgent?: boolean }} [options] `urgent` cancels any deferral, for
   *   changes that must not wait for a lyric boundary (new track, pause).
   */
  set(activity, options = {}) {
    const next = activity ?? null;
    if (!this._differs(next, this._desired)) return;

    this._desired = next;
    this._dirty = true;

    if (options.urgent && this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._schedule();
  }

  /** Drop the presence immediately, bypassing coalescing (but not the limit). */
  clear() {
    this.set(null);
  }

  /** Milliseconds until the next send is permitted (0 when a slot is free). */
  waitTime(now = Date.now()) {
    this._prune(now);
    if (this._sends.length < this.limit) return 0;
    return Math.max(0, this._sends[0] + this.windowMs - now);
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  // ---------------------------------------------------------------- internals

  _prune(now) {
    const cutoff = now - this.windowMs;
    while (this._sends.length && this._sends[0] <= cutoff) this._sends.shift();
  }

  /**
   * Decide *when* to send, which is where timing accuracy is won or lost.
   *
   * The naive rule — send as soon as the limiter allows — makes the visible lag
   * depend on where the lyric boundary happens to fall inside the window: a
   * line changing just after a send waits the full `step`, one changing just
   * before the next slot arrives almost instantly. That variance is why a fixed
   * lead-in cannot fix the timing; it over-corrects one case and under-corrects
   * the other.
   *
   * So when the next boundary is known, compare the two options directly:
   *
   *   send at the free slot -> the line we send is already stale, and stays
   *                            wrong from the boundary until the slot after
   *                            that: (free + step) - boundary
   *   wait for the boundary -> we show the previous line a little longer, but
   *                            then land exactly on the new one: boundary - free
   *
   * Waiting wins whenever `boundary - free < step / 2`. That single comparison
   * removes both the "too early" and the "too late" failure modes.
   */
  _schedule() {
    if (!this._dirty || this._timer) return;

    const now = Date.now();
    const free = now + this.waitTime(now);
    let sendAt = free;

    const boundary = this._nextChangeAt;
    if (boundary !== null && boundary > free && boundary - free < this.step / 2) {
      sendAt = boundary;
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, Math.max(0, sendAt - now));
    this._timer.unref?.();
  }

  _flush() {
    if (!this._dirty) return;
    if (!this.ipc.connected) {
      // Stay dirty; the 'connected' handler re-schedules us.
      return;
    }
    if (this.waitTime() > 0) {
      this._schedule();
      return;
    }

    // Re-read the content at the instant it goes out. Between noticing a change
    // and getting a slot, the current lyric line may well have moved on — this
    // is what keeps the sent line the one that is correct *now*.
    // A cleared presence stays cleared: the provider only refines real content.
    if (this._desired !== null && this.provider) {
      const fresh = this.provider();
      if (fresh) this._desired = fresh;
    }

    // Re-check against what is actually applied: the desired activity may have
    // drifted back to the current one while we were waiting for a slot.
    if (!this._differs(this._desired, this._applied)) {
      this._dirty = false;
      return;
    }

    const ok = this.ipc.setActivity(this._desired);
    if (!ok) return; // connection died mid-flight; retry on reconnect

    this._sends.push(Date.now());
    this._applied = this._desired;
    this._dirty = false;
    this.onSend?.(this._desired);
  }

  /**
   * Structural comparison that ignores noise we do not want to spend rate-limit
   * budget on — chiefly sub-second timestamp drift, which would otherwise make
   * every single tick look like a change.
   */
  _differs(a, b) {
    if (a === b) return false;
    if (a === null || b === null) return true;

    if (a.type !== b.type) return true;
    if ((a.details ?? '') !== (b.details ?? '')) return true;
    if ((a.state ?? '') !== (b.state ?? '')) return true;

    const at = a.timestamps ?? {};
    const bt = b.timestamps ?? {};
    if (!nearlyEqual(at.start, bt.start)) return true;
    if (!nearlyEqual(at.end, bt.end)) return true;

    const aa = a.assets ?? {};
    const ba = b.assets ?? {};
    for (const key of ['large_image', 'large_text', 'small_image', 'small_text']) {
      if ((aa[key] ?? '') !== (ba[key] ?? '')) return true;
    }

    const ab = a.buttons ?? [];
    const bb = b.buttons ?? [];
    if (ab.length !== bb.length) return true;
    for (let i = 0; i < ab.length; i++) {
      if (ab[i].label !== bb[i].label || ab[i].url !== bb[i].url) return true;
    }

    return false;
  }
}

function nearlyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= TIMESTAMP_TOLERANCE_MS;
}

module.exports = { PresenceController, RATE_LIMIT, RATE_WINDOW_MS };
