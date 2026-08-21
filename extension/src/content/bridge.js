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

  let last = null;
  let lastSentAt = 0;
  let lastSentPosition = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[CHANNEL] !== true) return;

    handle(data.snapshot);
  });

  function handle(snapshot) {
    // A browsing snapshot has no title by design; it says "a YouTube tab is
    // open and in front" and nothing more.
    if (snapshot && snapshot.idle) {
      if (!last || !last.idle || last.page !== snapshot.page || overdue()) {
        last = snapshot;
        lastSentAt = Date.now();
        lastSentPosition = 0;
        send({ type: 'state', payload: snapshot });
      }
      return;
    }

    if (!snapshot || !snapshot.title) {
      if (last) {
        last = null;
        send({ type: 'clear', payload: { reason: 'no-media' } });
      }
      return;
    }

    if (shouldSend(snapshot)) {
      last = snapshot;
      lastSentAt = Date.now();
      lastSentPosition = snapshot.position;
      send({ type: 'state', payload: snapshot });
    } else {
      last = snapshot;
    }
  }

  function overdue() {
    return Date.now() - lastSentAt >= HEARTBEAT_MS;
  }

  function shouldSend(snapshot) {
    if (!last) return true;
    if (last.idle) return true; // coming back from browsing is always news
    if (snapshot.videoId !== last.videoId) return true;
    if (snapshot.paused !== last.paused) return true;
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
    if (last) send({ type: 'clear', payload: { reason: 'pagehide' } });
  });
})();
