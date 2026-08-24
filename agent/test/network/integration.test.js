'use strict';

/**
 * Integration tests — these touch the network and open a real socket.
 *
 * Run with `npm run test:integration`. They are kept out of the default `npm
 * test` run so a flaky connection never fails a normal check, and every network
 * test skips itself (rather than failing) when LRCLIB is unreachable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { WebSocket } = require('ws');

const { LyricsProvider } = require('../../src/lyrics/lrclib');
const { Bridge } = require('../../src/bridge');
const { lineAt } = require('../../src/lyrics/lrc');

const SILENT = { info() {}, warn() {}, debug() {}, error() {} };
const PORT = 18787; // well away from the default, so a running agent is safe

// ------------------------------------------------------------------- LRCLIB

test('LRCLIB returns time-synced lyrics for a known track', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overtone-test-'));
  const provider = new LyricsProvider({
    cacheDir,
    userAgent: 'Overtone/1.0.0 (integration test)',
    logger: SILENT,
  });

  let result;
  try {
    result = await provider.lookup({
      artist: 'Rick Astley',
      track: 'Never Gonna Give You Up',
      duration: 213,
    });
  } catch (err) {
    t.skip(`LRCLIB nicht erreichbar: ${err.message}`);
    return;
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }

  if (!result) {
    t.skip('LRCLIB lieferte keinen Treffer (Datenbank oder Netzwerk).');
    return;
  }

  // What this test is for is the contract — that the API still answers in the
  // shape we parse — not the contents of somebody else's database. Asserting a
  // line count failed the day LRCLIB's entry for this track was reduced to a
  // single line, which said nothing about our code.
  assert.equal(result.synced, true, 'synchronisierte Lyrics erwartet');
  assert.ok(result.lines.length >= 1, 'mindestens eine Zeile erwartet');
  assert.ok(
    result.lines.every((line) => Number.isFinite(line.time) && typeof line.text === 'string'),
    'jede Zeile braucht eine Zeit und einen Text',
  );

  // Timestamps must be ordered and within the track.
  for (let i = 1; i < result.lines.length; i++) {
    assert.ok(result.lines[i].time >= result.lines[i - 1].time, 'Zeitstempel müssen sortiert sein');
  }
  assert.ok(result.lines.at(-1).time < 260, 'letzte Zeile darf nicht hinter dem Songende liegen');

  // And the whole point: a position must resolve to a line.
  const hit = lineAt(result.lines, result.lines[0].time + 0.5);
  assert.ok(hit && hit.text.length >= 0, 'die erste Zeile muss auflösbar sein');

  if (result.lines.length < 10) {
    t.diagnostic(`LRCLIB lieferte nur ${result.lines.length} Zeile(n) — dort haben sich Daten geändert.`);
  }
});

test('LyricsProvider caches, so a repeat lookup makes no request', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overtone-test-'));
  const provider = new LyricsProvider({
    cacheDir,
    userAgent: 'Overtone/1.0.0 (integration test)',
    logger: SILENT,
  });

  try {
    const query = { artist: 'Rick Astley', track: 'Never Gonna Give You Up', duration: 213 };

    const first = await provider.lookup(query);
    if (!first) {
      t.skip('LRCLIB nicht erreichbar.');
      return;
    }

    // Break the network for the second call: a cache hit must not notice.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('Es hätte keine Anfrage gestellt werden dürfen');
    };
    try {
      const second = await provider.lookup(query);
      assert.equal(second.lines.length, first.lines.length);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- bridge

test('Bridge accepts an extension origin and relays state', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    const received = new Promise((resolve) => bridge.once('state', resolve));

    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    await once(socket, 'open');

    socket.send(JSON.stringify({ type: 'state', payload: { title: 'Testtitel', videoId: 'abc' } }));

    const payload = await received;
    assert.equal(payload.title, 'Testtitel');

    socket.close();
  } finally {
    await bridge.stop();
  }
});

test('Bridge passes the extension capability list through', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    const greeting = new Promise((resolve) => bridge.once('hello', resolve));

    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'hello',
        payload: { client: 'extension', version: '1.1.0', features: ['captions'] },
      }),
    );

    const payload = await greeting;
    assert.deepEqual(payload.features, ['captions']);
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test('Bridge reports an outdated extension as feature-less rather than failing', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    const greeting = new Promise((resolve) => bridge.once('hello', resolve));

    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    await once(socket, 'open');
    // A pre-1.1.0 extension sends no `features` key at all.
    socket.send(
      JSON.stringify({ type: 'hello', payload: { client: 'extension', version: '1.0.0' } }),
    );

    const payload = await greeting;
    assert.equal(payload.features, undefined, 'alte Extensions senden kein features-Feld');

    // main.js normalises exactly this way, and keys the warning off the result:
    // an absent list means "cannot do captions", not "unknown".
    const features = Array.isArray(payload.features) ? payload.features : [];
    assert.deepEqual(features, []);
    assert.equal(features.includes('captions'), false);

    socket.close();
  } finally {
    await bridge.stop();
  }
});

test('Bridge rejects a web page origin', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'https://evil.example.com' },
    });

    // Resolve either way rather than reusing the throwing `once` helper — here
    // the rejection IS the expected outcome, not a test failure.
    const outcome = await new Promise((resolve) => {
      socket.on('open', () => resolve({ result: 'open' }));
      socket.on('error', (err) => resolve({ result: 'rejected', message: err.message }));
    });

    assert.equal(outcome.result, 'rejected', 'eine Webseite darf keine Presence senden dürfen');
    assert.match(outcome.message, /403/, 'die Ablehnung muss ein HTTP 403 sein');
    socket.terminate();
  } finally {
    await bridge.stop();
  }
});

test('Bridge accepts a client without an Origin header', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    // Native clients send no Origin; they already have local code execution, so
    // blocking them would buy nothing.
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await once(socket, 'open');
    socket.close();
  } finally {
    await bridge.stop();
  }
});

test('Bridge clears the presence when the last client disconnects', async () => {
  const bridge = new Bridge({ port: PORT, logger: SILENT });
  await bridge.start();

  try {
    const cleared = new Promise((resolve) => bridge.once('clear', resolve));

    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
    });
    await once(socket, 'open');
    socket.close();

    const payload = await cleared;
    assert.equal(payload.reason, 'no-clients');
  } finally {
    await bridge.stop();
  }
});

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (value) => {
      cleanup();
      resolve(value);
    };
    const onError = (err) => {
      cleanup();
      if (event === 'error') resolve(err);
      else reject(err);
    };
    const cleanup = () => {
      emitter.removeEventListener?.(event, onEvent);
      emitter.off?.(event, onEvent);
      emitter.off?.('error', onError);
    };

    emitter.on(event, onEvent);
    if (event !== 'error') emitter.on('error', onError);
  });
}
