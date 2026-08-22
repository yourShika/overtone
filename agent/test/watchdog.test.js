'use strict';

/**
 * The auto-reload decision.
 *
 * This is the only code in the project that acts on the user's browser without
 * being asked, so the tests that matter most are the ones asserting it does
 * nothing. Buffering, pausing and slow playback each resemble the fault from
 * one angle; treating any of them as a wedged player would be worse than the
 * fault, because it would interrupt playback that was about to work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const RULES = require('../../extension/src/content/watchdog');

const NOW = 1_700_000_000_000;
const STARVED = { readyState: 1, networkState: 2, buffered: '', errorCode: null };

/** A player that says it is playing but holds no data. */
function stuck(position = 0) {
  return { videoId: 'abc', title: 'T', paused: false, idle: false, position, fault: STARVED };
}
function healthy(position = 30) {
  return { videoId: 'abc', title: 'T', paused: false, idle: false, position, fault: null };
}

const base = {
  now: NOW,
  troubleSince: null,
  troublePosition: null,
  attempts: 0,
  lastAttemptAt: 0,
  typing: false,
  enabled: true,
};

// ------------------------------------------------------- must never reload

test('healthy playback is left alone', () => {
  assert.equal(RULES.evaluate({ ...base, snapshot: healthy() }).action, 'reset');
});

test('a paused video is not a stuck one', () => {
  const snapshot = { ...stuck(), paused: true };
  assert.equal(RULES.evaluate({ ...base, snapshot }).action, 'reset');
});

test('browsing without playback is not a stuck one', () => {
  const snapshot = { ...stuck(), idle: true };
  assert.equal(RULES.evaluate({ ...base, snapshot }).action, 'reset');
});

test('buffering that still advances never triggers a reload', () => {
  // Starved on every sample, but the position keeps creeping forward: this is
  // a slow connection, not a wedged pipeline.
  let state = { ...base, snapshot: stuck(0) };
  let result = RULES.evaluate(state);

  for (let i = 1; i <= 60; i++) {
    result = RULES.evaluate({
      ...base,
      snapshot: stuck(i * 2), // two seconds of progress per sample
      now: NOW + i * 1000,
      troubleSince: result.troubleSince,
      troublePosition: result.troublePosition,
    });
    assert.notEqual(result.action, 'reload', `Sample ${i} hätte nicht neu laden dürfen`);
  }
});

test('a brief hiccup is not long enough', () => {
  const first = RULES.evaluate({ ...base, snapshot: stuck() });
  const later = RULES.evaluate({
    ...base,
    snapshot: stuck(),
    now: NOW + RULES.STUCK_AFTER_MS - 1000,
    troubleSince: first.troubleSince,
    troublePosition: first.troublePosition,
  });
  assert.equal(later.action, 'wait');
  assert.equal(later.reason, 'not-long-enough');
});

test('nothing happens while the user is typing', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: stuck(),
    now: NOW + RULES.STUCK_AFTER_MS + 1000,
    troubleSince: NOW,
    troublePosition: 0,
    typing: true,
  });
  assert.equal(result.action, 'wait');
  assert.equal(result.reason, 'user-typing');
});

test('switched off means switched off', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: stuck(),
    now: NOW + RULES.STUCK_AFTER_MS + 1000,
    troubleSince: NOW,
    troublePosition: 0,
    enabled: false,
  });
  assert.equal(result.action, 'reset');
});

// ------------------------------------------------------------ must reload

test('a genuinely wedged player is reloaded', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: stuck(0),
    now: NOW + RULES.STUCK_AFTER_MS + 1,
    troubleSince: NOW,
    troublePosition: 0,
  });
  assert.equal(result.action, 'reload');
  assert.equal(result.troubleSince, null, 'der Zähler startet nach dem Laden neu');
});

// --------------------------------------------------------------- restraint

test('a second reload waits for the cooldown', () => {
  const soon = RULES.evaluate({
    ...base,
    snapshot: stuck(0),
    now: NOW + RULES.STUCK_AFTER_MS + 1,
    troubleSince: NOW,
    troublePosition: 0,
    attempts: 1,
    lastAttemptAt: NOW,
  });
  assert.equal(soon.reason, 'cooldown');

  const later = RULES.evaluate({
    ...base,
    snapshot: stuck(0),
    now: NOW + RULES.RELOAD_COOLDOWN_MS + 1,
    troubleSince: NOW,
    troublePosition: 0,
    attempts: 1,
    lastAttemptAt: NOW,
  });
  assert.equal(later.action, 'reload');
});

test('it gives up rather than reloading forever', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: stuck(0),
    now: NOW + RULES.RELOAD_COOLDOWN_MS * 5,
    troubleSince: NOW,
    troublePosition: 0,
    attempts: RULES.MAX_RELOADS,
    lastAttemptAt: NOW,
  });
  assert.equal(result.action, 'giveup');
});

test('a long healthy stretch clears the attempt count', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: healthy(),
    now: NOW + RULES.RECOVERY_MS + 1,
    attempts: 2,
    lastAttemptAt: NOW,
  });
  assert.equal(result.action, 'forgive');
});

test('a recent reload is not forgiven yet', () => {
  const result = RULES.evaluate({
    ...base,
    snapshot: healthy(),
    now: NOW + 60_000,
    attempts: 2,
    lastAttemptAt: NOW,
  });
  assert.equal(result.action, 'reset', 'gesund, aber der Zähler bleibt stehen');
});

test('the reported fault must actually mean no data', () => {
  // A fault carrying readyState 3 is a player that has data — not our case.
  const snapshot = { ...stuck(), fault: { readyState: 3, networkState: 2 } };
  const result = RULES.evaluate({
    ...base,
    snapshot,
    now: NOW + RULES.STUCK_AFTER_MS + 1,
    troubleSince: NOW,
    troublePosition: 0,
  });
  assert.equal(result.action, 'reset');
});

// --------------------------------------------- the case that was being missed

test('a player stuck in BUFFERING is caught, not only one claiming to PLAY', () => {
  // Reproduces the reported fault from its media-internals trace: the pipeline
  // sat in kStarting, so the player reported BUFFERING (3) and networkState
  // stayed at LOADING (2). Requiring PLAYING or NO_SOURCE meant the watchdog
  // never started its clock, which is why it helped only sometimes.
  const buffering = {
    videoId: 'abc',
    title: 'T',
    paused: false,
    idle: false,
    position: 0,
    fault: { readyState: 1, networkState: 2, playerState: 3, buffered: 0, errorCode: null },
  };

  const first = RULES.evaluate({ ...base, snapshot: buffering });
  assert.equal(first.action, 'wait', 'die Uhr muss überhaupt starten');

  const later = RULES.evaluate({
    ...base,
    snapshot: buffering,
    now: NOW + RULES.STUCK_AFTER_MS + 1,
    troubleSince: first.troubleSince,
    troublePosition: first.troublePosition,
  });
  assert.equal(later.action, 'reload');
});

test('normal buffering at the start of a video is not reloaded', () => {
  // Same shape, but the position advances once data arrives — which is what
  // separates a slow start from a wedged one.
  const buffering = (position) => ({
    videoId: 'abc',
    title: 'T',
    paused: false,
    idle: false,
    position,
    fault: { readyState: 1, networkState: 2, playerState: 3, buffered: 0, errorCode: null },
  });

  let result = RULES.evaluate({ ...base, snapshot: buffering(0) });
  for (let i = 1; i <= 40; i++) {
    result = RULES.evaluate({
      ...base,
      snapshot: buffering(i * 1.5),
      now: NOW + i * 1000,
      troubleSince: result.troubleSince,
      troublePosition: result.troublePosition,
    });
    assert.notEqual(result.action, 'reload', `Sekunde ${i} hätte nicht neu laden dürfen`);
  }
});
