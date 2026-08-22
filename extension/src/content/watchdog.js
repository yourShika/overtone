'use strict';

/**
 * Decides whether a wedged YouTube player warrants reloading the page.
 *
 * Kept separate from bridge.js, and free of DOM and browser APIs, for one
 * reason: this code reloads someone's page without asking. Every rule below can
 * therefore be exercised in a test, including the ones that must *not* fire —
 * buffering, pausing, and slow-but-progressing playback all resemble the fault
 * from one angle each, and mistaking any of them for it would be worse than the
 * fault itself.
 *
 * Loaded as a plain content script before bridge.js, so it shares the isolated
 * world's globals rather than importing.
 */

/** Trouble must persist this long before a reload is considered. */
const STUCK_AFTER_MS = 20000;
/** Playback moving less than this counts as not moving. */
const PROGRESS_EPSILON_S = 0.5;
/** Never reload more often than this, however bad it looks. */
const RELOAD_COOLDOWN_MS = 120000;
/** Give up after this many: reloading plainly is not the cure. */
const MAX_RELOADS = 3;
/** Healthy for this long and the attempt count resets. */
const RECOVERY_MS = 600000;

/**
 * @param {object} input
 * @param {object|null} input.snapshot   latest player snapshot
 * @param {number} input.now             epoch ms
 * @param {number|null} input.troubleSince    when the current bad stretch began
 * @param {number|null} input.troublePosition position when it began
 * @param {number} input.attempts        reloads already made in this tab
 * @param {number} input.lastAttemptAt   epoch ms of the last one, 0 if none
 * @param {boolean} input.typing         focus is in a text field
 * @param {boolean} input.enabled        the user wants this at all
 * @returns {{ action: 'reset'|'wait'|'reload'|'giveup'|'forgive',
 *             troubleSince: number|null, troublePosition: number|null,
 *             reason: string }}
 */
function evaluate({
  snapshot,
  now,
  troubleSince = null,
  troublePosition = null,
  attempts = 0,
  lastAttemptAt = 0,
  typing = false,
  enabled = true,
}) {
  const clear = (reason) => ({
    action: 'reset',
    troubleSince: null,
    troublePosition: null,
    reason,
  });

  if (!enabled) return clear('disabled');
  if (!snapshot) return clear('no-snapshot');
  if (snapshot.idle) return clear('browsing');
  if (snapshot.paused) return clear('paused');

  // Only the player admitting it holds no data counts. Everything else here is
  // ordinary operation seen from an unusual angle.
  const starved = Boolean(snapshot.fault) && snapshot.fault.readyState < 2;

  if (!starved) {
    // A long healthy stretch is the only evidence that earlier reloads worked.
    if (attempts > 0 && lastAttemptAt && now - lastAttemptAt >= RECOVERY_MS) {
      return { action: 'forgive', troubleSince: null, troublePosition: null, reason: 'recovered' };
    }
    return clear('healthy');
  }

  if (troubleSince === null) {
    return {
      action: 'wait',
      troubleSince: now,
      troublePosition: snapshot.position,
      reason: 'first-sight',
    };
  }

  // Slow buffering still advances eventually; a wedged pipeline never does. So
  // any real progress restarts the clock rather than counting towards it.
  if (Math.abs(snapshot.position - troublePosition) > PROGRESS_EPSILON_S) {
    return {
      action: 'wait',
      troubleSince: now,
      troublePosition: snapshot.position,
      reason: 'still-progressing',
    };
  }

  const held = { action: 'wait', troubleSince, troublePosition };

  if (now - troubleSince < STUCK_AFTER_MS) return { ...held, reason: 'not-long-enough' };
  if (attempts >= MAX_RELOADS) return { ...held, action: 'giveup', reason: 'attempts-exhausted' };
  if (now - lastAttemptAt < RELOAD_COOLDOWN_MS) return { ...held, reason: 'cooldown' };
  // Never yank the page out from under someone mid-sentence.
  if (typing) return { ...held, reason: 'user-typing' };

  return { action: 'reload', troubleSince: null, troublePosition: null, reason: 'stuck' };
}

const OvertoneWatchdog = {
  evaluate,
  STUCK_AFTER_MS,
  PROGRESS_EPSILON_S,
  RELOAD_COOLDOWN_MS,
  MAX_RELOADS,
  RECOVERY_MS,
};

// Content script in the isolated world; also require()-able from tests.
if (typeof globalThis !== 'undefined') globalThis.OvertoneWatchdog = OvertoneWatchdog;
if (typeof module !== 'undefined' && module.exports) module.exports = OvertoneWatchdog;
