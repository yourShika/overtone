'use strict';

/**
 * Content bridge — runs in the extension's ISOLATED world.
 *
 * Receives snapshots from probe.js (MAIN world) and forwards them to the
 * service worker. It deliberately does NOT forward every tick:
 *
 *   - Sending 1 Hz per tab would be pure noise; the agent extrapolates the
 *     position between reports anyway.
 *   - But we must send promptly on anything the agent cannot predict: a new
 *     video, a pause, or a seek.
 *
 * The 5-second heartbeat has a second job: every runtime message resets the MV3
 * service worker's 30-second idle timer, so an actively playing tab keeps the
 * worker (and therefore the WebSocket to the agent) alive.
 */

(() => {
  const CHANNEL = '__overtone__';
  const HEARTBEAT_MS = 5000;
  /** Position drift beyond this means the user seeked. */
  const SEEK_TOLERANCE_S = 2;
  /**
   * How long a title-less frame must persist before the presence is retracted.
   *
   * Has to be a timer rather than a count of bad frames: probe.js skips payloads
   * identical to the previous one, so a run of nulls arrives here as exactly one
   * message and a counter would never advance past 1.
   */
  const CLEAR_GRACE_MS = 3000;

  // Decision rules live in watchdog.js so they can be tested; this file only
  // carries them out. See that file for why each guard exists.
  const RULES = globalThis.OvertoneWatchdog;
  const STORE_KEY = 'overtone.watchdog';

  let last = null;
  let lastSentAt = 0;
  let lastSentPosition = 0;
  /** Pending retraction, armed by a title-less frame and disarmed by a good one. */
  let clearTimer = null;

  /** When the current uninterrupted stretch of trouble began. */
  let troubleSince = null;
  /** Last position seen while in trouble, to tell stuck from merely slow. */
  let troublePosition = null;
  let watchdogEnabled = true;

  chrome.storage.local
    .get({ autoReload: true })
    .then(({ autoReload }) => {
      watchdogEnabled = autoReload;
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.autoReload) watchdogEnabled = changes.autoReload.newValue;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true) return;

    handle(data.snapshot);
  });

  function handle(snapshot) {
    watchdog(snapshot);

    // A browsing snapshot has no title by design; it says "a YouTube tab is
    // open and in front" and nothing more.
    if (snapshot && snapshot.idle) {
      cancelClear();
      if (!last || !last.idle || last.page !== snapshot.page || overdue()) {
        last = snapshot;
        lastSentAt = Date.now();
        lastSentPosition = 0;
        send({ type: 'state', payload: snapshot });
      }
      return;
    }

    // One bad frame is not the end of playback. getVideoData() comes back empty
    // and the player reports UNSTARTED or CUED for a tick or two every time
    // YouTube swaps the media element — an ad break, a quality change, an SPA
    // navigation — and yt-player-updated schedules an extra probe 250 ms into
    // exactly that window. Retracting on the first one made the agent forget the
    // track and then greet the very same song as new a second later.
    if (!snapshot || !snapshot.title) {
      scheduleClear('no-media');
      return;
    }
    cancelClear();

    if (shouldSend(snapshot)) {
      last = snapshot;
      lastSentAt = Date.now();
      lastSentPosition = snapshot.position;
      send({ type: 'state', payload: snapshot });
    } else {
      last = snapshot;
    }
  }

  /**
   * Apply the decision from watchdog.js.
   *
   * Counters live in sessionStorage so they survive the reload they cause,
   * which is the only way to notice that reloading did not help.
   */
  function watchdog(snapshot) {
    if (!RULES) return;

    const stored = readState();
    const active = document.activeElement;
    const decision = RULES.evaluate({
      snapshot,
      now: Date.now(),
      troubleSince,
      troublePosition,
      attempts: stored.count || 0,
      lastAttemptAt: stored.lastAt || 0,
      enabled: watchdogEnabled,
      typing: Boolean(
        active &&
          (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName || '')),
      ),
    });

    troubleSince = decision.troubleSince;
    troublePosition = decision.troublePosition;

    if (decision.action === 'forgive') {
      writeState({});
      return;
    }

    if (decision.action === 'giveup') {
      once('give-up', () =>
        report('watchdog:gave-up', { videoId: snapshot.videoId, attempts: stored.count }),
      );
      return;
    }

    if (decision.action !== 'reload') return;

    const attempt = (stored.count || 0) + 1;
    writeState({ count: attempt, lastAt: Date.now() });
    report('watchdog:reloading', {
      videoId: snapshot.videoId,
      title: snapshot.title,
      attempt,
      readyState: snapshot.fault?.readyState,
      networkState: snapshot.fault?.networkState,
    });

    // Let the message reach the agent before the page goes away.
    setTimeout(() => location.reload(), 250);
  }

  function readState() {
    try {
      return JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function writeState(state) {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
      /* storage disabled; the caps simply stop applying */
    }
  }

  const said = new Set();
  function once(key, fn) {
    if (said.has(key)) return;
    said.add(key);
    fn();
  }

  function report(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload });
    } catch {
      /* worker asleep; the reload still happens */
    }
  }

  /** Arm the retraction; a usable snapshot arriving first calls it off. */
  function scheduleClear(reason) {
    if (clearTimer || !last) return;
    clearTimer = setTimeout(() => {
      clearTimer = null;
      if (!last) return;
      last = null;
      send({ type: 'clear', payload: { reason } });
    }, CLEAR_GRACE_MS);
  }

  function cancelClear() {
    if (!clearTimer) return;
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  function overdue() {
    return Date.now() - lastSentAt >= HEARTBEAT_MS;
  }

  function shouldSend(snapshot) {
    if (!last) return true;
    if (last.idle) return true; // coming back from browsing is always news
    if (snapshot.videoId !== last.videoId) return true;
    if (snapshot.paused !== last.paused) return true;
    // Starting or ending a stall changes whether the position may be trusted.
    if (snapshot.buffering !== last.buffering) return true;
    if (snapshot.title !== last.title) return true;
    // A new subtitle line is the whole point when captions drive the lyrics —
    // the agent cannot predict it, so it has to be pushed.
    if (snapshot.caption !== last.caption) return true;

    const elapsed = (Date.now() - lastSentAt) / 1000;
    if (elapsed >= HEARTBEAT_MS / 1000) return true;

    // Detect a seek by comparing against where playback *should* be by now.
    const expected = snapshot.paused
      ? lastSentPosition
      : lastSentPosition + elapsed * (snapshot.playbackRate || 1);
    return Math.abs(snapshot.position - expected) > SEEK_TOLERANCE_S;
  }

  function send(message) {
    try {
      // The worker may be mid-restart; a rejected promise here is normal and
      // the next heartbeat will retry.
      chrome.runtime.sendMessage(message)?.catch?.(() => {});
    } catch {
      /* extension context invalidated (update/reload) */
    }
  }

  // Closing the tab or navigating away must retract the presence.
  window.addEventListener('pagehide', () => {
    // The page really is going; no grace period applies.
    cancelClear();
    if (last) send({ type: 'clear', payload: { reason: 'pagehide' } });
  });
})();
