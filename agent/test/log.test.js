'use strict';

/**
 * Logger tests.
 *
 * The point of these is the guarantee the settings window and the docs rely on:
 * a line is on disk the moment it is logged, not whenever a buffer decides to
 * flush. An earlier stream-based implementation left the file empty for as long
 * as the app ran, which made "open the log folder" useless advice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger } = require('../src/log');

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtone-log-'));
  return { dir, file: path.join(dir, 'nested', 'overtone.log') };
}

test('a logged line is readable immediately, without closing the logger', () => {
  const { dir, file } = tempLog();
  const logger = new Logger({ filePath: file, level: 'info' });

  try {
    logger.info('Erste Zeile');

    // No close(), no delay — this is the whole guarantee.
    const contents = fs.readFileSync(file, 'utf8');
    assert.match(contents, /\[INFO\] Erste Zeile/);
  } finally {
    logger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the log directory is created on demand', () => {
  const { dir, file } = tempLog();
  const logger = new Logger({ filePath: file, level: 'info' });

  try {
    logger.info('x');
    assert.ok(fs.existsSync(file));
  } finally {
    logger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entries below the configured level reach neither buffer nor file', () => {
  const { dir, file } = tempLog();
  const logger = new Logger({ filePath: file, level: 'warn' });

  try {
    logger.debug('unsichtbar');
    logger.info('auch unsichtbar');
    logger.warn('sichtbar');

    const contents = fs.readFileSync(file, 'utf8');
    assert.ok(!contents.includes('unsichtbar'));
    assert.match(contents, /\[WARN\] sichtbar/);
    assert.equal(logger.history().length, 1);
  } finally {
    logger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the in-memory ring buffer stays bounded', () => {
  const logger = new Logger({ level: 'info' }); // no file

  for (let i = 0; i < 700; i++) logger.info(`Zeile ${i}`);

  const history = logger.history();
  assert.equal(history.length, 500);
  // Oldest entries are dropped, newest survive.
  assert.equal(history.at(-1).message, 'Zeile 699');
  assert.ok(!history.some((e) => e.message === 'Zeile 0'));
});

test('an Error is logged with its stack', () => {
  const logger = new Logger({ level: 'info' });
  logger.error(new Error('kaputt'));

  const last = logger.history().at(-1);
  assert.equal(last.level, 'error');
  assert.match(last.message, /kaputt/);
});

test('onEntry fires for every accepted entry', () => {
  const seen = [];
  const logger = new Logger({ level: 'info', onEntry: (e) => seen.push(e.message) });

  logger.debug('verworfen');
  logger.info('behalten');

  assert.deepEqual(seen, ['behalten']);
});

test('an unwritable path disables file logging instead of throwing', () => {
  // A path whose parent is a file, not a directory — mkdir must fail.
  const { dir } = tempLog();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');

  try {
    const logger = new Logger({ filePath: path.join(blocker, 'overtone.log'), level: 'info' });
    // Must not throw, and the in-memory buffer must still work.
    logger.info('trotzdem geloggt');
    assert.equal(logger.history().length, 1);
    logger.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file rotates once it grows past the limit', () => {
  const { dir, file } = tempLog();
  const logger = new Logger({ filePath: file, level: 'info' });

  try {
    const chunk = 'x'.repeat(2000);
    for (let i = 0; i < 400; i++) logger.info(chunk); // ~800 KB > 512 KB limit

    assert.ok(fs.existsSync(`${file}.1`), 'die Vorgängergeneration muss existieren');
    assert.ok(fs.statSync(file).size < 512 * 1024, 'die aktive Datei muss geschrumpft sein');
  } finally {
    logger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
