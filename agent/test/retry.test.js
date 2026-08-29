'use strict';

/**
 * What the window needs in order to offer a second attempt.
 *
 * A failed transcription writes no file, so the failure entry is the only
 * record that the attempt happened — and the only place the video id survives.
 * These pin that down, because losing it turns the retry button into a button
 * that cannot do anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Transcriber } = require('../src/lyrics/transcriber');
const { Session } = require('../src/session');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function make() {
  return new Transcriber({
    workDir: 'nowhere',
    libraryDir: 'nowhere',
    script: 'nowhere',
    logger: quiet,
  });
}

test('a failure keeps the identifiers a retry needs', () => {
  const tr = make();
  tr._record('Rick Astley — Never Gonna Give You Up', 'failed', 'the download timed out', {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    artist: 'Rick Astley',
    track: 'Never Gonna Give You Up',
  });

  const [entry] = tr.report().history;
  assert.equal(entry.videoId, 'dQw4w9WgXcQ');
  assert.equal(entry.artist, 'Rick Astley');
  assert.equal(entry.track, 'Never Gonna Give You Up');
  assert.equal(entry.retry, true, 'ein Fehlschlag mit Kennung ist wiederholbar');
});

test('nothing else is offered as retryable', () => {
  const tr = make();

  // Succeeded: there is a file now, and the library handles that one.
  tr._record('A', 'ok', null, { videoId: 'dQw4w9WgXcQ' });
  // Failed before it ever got an id — nothing to hand a worker.
  tr._record('B', 'failed', 'no id', {});

  const offered = tr.report().history.filter((entry) => entry.retry);
  assert.deepEqual(offered, [], 'weder Erfolg noch Fehlschlag ohne Kennung');
});

test('nothing is offered while a job is running', () => {
  const tr = make();
  tr._record('A', 'failed', 'boom', { videoId: 'dQw4w9WgXcQ' });
  assert.equal(tr.report().history[0].retry, true);

  // One at a time is the rule the class already enforces; the window must not
  // offer a button that submit() would only refuse.
  tr.busyWith = 'someOtherId';
  assert.equal(tr.report().history[0].retry, false);
});

test('forgetting a track lets it be attempted again', () => {
  const tr = make();
  tr.attempted.add('dQw4w9WgXcQ');
  tr.consecutiveFailures = 3;

  assert.equal(tr.canStart('dQw4w9WgXcQ'), false, 'vorher gesperrt');
  tr.forget('dQw4w9WgXcQ');
  assert.equal(tr.canStart('dQw4w9WgXcQ'), true, 'nach forget() wieder möglich');
});

test('the history stays capped once retries pile up', () => {
  const tr = make();
  for (let i = 0; i < 40; i++) tr._record(`t${i}`, 'failed', 'boom', { videoId: 'dQw4w9WgXcQ' });

  assert.equal(tr.history.length, 20, 'intern gedeckelt');
  assert.equal(tr.report().history.length, 5, 'im Fenster fünf, neueste zuerst');
  assert.equal(tr.report().history[0].label, 't39');
});

test('a new subtitle line is reported as a change', () => {
  const session = new Session();
  const base = { videoId: 'dQw4w9WgXcQ', title: 'x', position: 10, duration: 100 };

  session.update({ ...base, caption: 'We are no strangers to love' });
  const same = session.update({ ...base, position: 11, caption: 'We are no strangers to love' });
  assert.equal(same.captionChanged, false, 'dieselbe Zeile ist keine Neuigkeit');

  const next = session.update({ ...base, position: 13, caption: 'You know the rules' });
  assert.equal(next.captionChanged, true, 'eine neue Zeile schon');

  // Subtitles being switched off is a change too — the line has to come down.
  const off = session.update({ ...base, position: 15, caption: '' });
  assert.equal(off.captionChanged, true);
});
