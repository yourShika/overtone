'use strict';

/**
 * Lyrics library: the on-disk .lrc files.
 *
 * The rule that matters most here is that a file you edited by hand is never
 * replaced by a fetched one. Getting that wrong loses work silently, and the
 * loss would only surface much later, when the corrected timing is gone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { LyricsLibrary, formatTimestamp, safeName, MANAGED_MARKER } = require('../src/lyrics/library');

const QUIET = { warn() {}, info() {}, debug() {} };
const LINES = [
  { time: 0, text: 'Erste Zeile' },
  { time: 4.25, text: 'Zweite Zeile' },
  { time: 61.5, text: 'Nach einer Minute' },
];

async function withLibrary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overtone-lyrics-'));
  try {
    await run(new LyricsLibrary({ directory: dir, logger: QUIET }), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('store writes a file that parses back to the same timings', async () => {
  await withLibrary(async (library, dir) => {
    const written = await library.store({
      videoId: 'abc123',
      artist: 'doli, szevczor',
      track: '162020',
      lines: LINES,
    });
    assert.equal(written, true);

    const raw = await fs.readFile(path.join(dir, 'abc123.lrc'), 'utf8');
    assert.ok(raw.includes('[ti:162020]'));
    assert.ok(raw.includes('[00:04.25]Zweite Zeile'));
    assert.ok(raw.includes('[01:01.50]Nach einer Minute'));

    const hit = await library.find({ videoId: 'abc123' });
    assert.deepEqual(
      hit.lines.map((l) => [l.time, l.text]),
      LINES.map((l) => [l.time, l.text]),
    );
    assert.equal(hit.managed, true);
  });
});

test('store refuses to overwrite a file written by hand', async () => {
  await withLibrary(async (library, dir) => {
    const file = path.join(dir, 'abc123.lrc');
    await fs.writeFile(file, '[00:00.00]Meine eigene, korrigierte Fassung\n', 'utf8');

    const written = await library.store({
      videoId: 'abc123',
      track: 'Whatever',
      lines: LINES,
    });

    assert.equal(written, false, 'darf nicht schreiben');
    const raw = await fs.readFile(file, 'utf8');
    assert.equal(raw.includes('korrigierte Fassung'), true, 'Inhalt muss unangetastet bleiben');
  });
});

test('store does replace a file it wrote itself', async () => {
  await withLibrary(async (library) => {
    await library.store({ videoId: 'abc123', track: 'A', lines: LINES });
    const written = await library.store({
      videoId: 'abc123',
      track: 'B',
      lines: [{ time: 1, text: 'Neu' }],
    });

    assert.equal(written, true);
    const hit = await library.find({ videoId: 'abc123' });
    assert.equal(hit.lines.length, 1);
    assert.equal(hit.lines[0].text, 'Neu');
  });
});

test('find prefers the video id over the artist-and-title name', async () => {
  await withLibrary(async (library, dir) => {
    await fs.writeFile(path.join(dir, 'abc123.lrc'), '[00:00.00]Nach ID gefunden\n', 'utf8');
    await fs.writeFile(path.join(dir, 'doli - 162020.lrc'), '[00:00.00]Nach Name gefunden\n', 'utf8');

    const hit = await library.find({ videoId: 'abc123', artist: 'doli', track: '162020' });
    assert.equal(hit.lines[0].text, 'Nach ID gefunden');
  });
});

test('find falls back to the artist-and-title name, so re-uploads still match', async () => {
  await withLibrary(async (library, dir) => {
    await fs.writeFile(path.join(dir, 'doli - 162020.lrc'), '[00:00.00]Nach Name gefunden\n', 'utf8');

    const hit = await library.find({ videoId: 'andere-id', artist: 'doli', track: '162020' });
    assert.equal(hit.lines[0].text, 'Nach Name gefunden');
    assert.equal(hit.managed, false, 'selbst angelegt, also nicht ersetzbar');
  });
});

test('find reports nothing rather than throwing when the folder is empty', async () => {
  await withLibrary(async (library) => {
    assert.equal(await library.find({ videoId: 'fehlt' }), null);
  });
});

test('find skips a file with no usable timestamps', async () => {
  await withLibrary(async (library, dir) => {
    await fs.writeFile(path.join(dir, 'abc123.lrc'), 'nur Text, keine Zeitmarken\n', 'utf8');
    assert.equal(await library.find({ videoId: 'abc123' }), null);
  });
});

test('store declines input it cannot key or use', async () => {
  await withLibrary(async (library) => {
    assert.equal(await library.store({ videoId: '', lines: LINES }), false);
    assert.equal(await library.store({ videoId: 'x', lines: [] }), false);
    assert.equal(await library.store({ videoId: 'x', lines: null }), false);
  });
});

test('stats separates saved copies from files you wrote', async () => {
  await withLibrary(async (library, dir) => {
    await library.store({ videoId: 'a', track: 'A', lines: LINES });
    await fs.writeFile(path.join(dir, 'eigenes.lrc'), '[00:00.00]Text\n', 'utf8');

    assert.deepEqual(await library.stats(), { total: 2, managed: 1 });
  });
});

test('list reports what a person would recognise, newest first', async () => {
  await withLibrary(async (library, dir) => {
    await library.store({ videoId: 'aaaaaaaaaaa', artist: 'doli', track: '162020', lines: LINES });
    await fs.writeFile(path.join(dir, 'eigenes.lrc'), '[00:00.00]Text\n', 'utf8');

    const entries = await library.list();
    assert.equal(entries.length, 2);

    const stored = entries.find((e) => e.name === 'aaaaaaaaaaa.lrc');
    assert.equal(stored.title, '162020');
    assert.equal(stored.artist, 'doli');
    assert.equal(stored.managed, true);
    assert.equal(stored.lines, 3);

    const own = entries.find((e) => e.name === 'eigenes.lrc');
    assert.equal(own.managed, false);
    assert.equal(own.title, 'eigenes', 'ohne [ti:] steht der Dateiname da');
  });
});

test('a name from the window cannot reach out of the folder', async () => {
  await withLibrary(async (library) => {
    assert.equal(library.resolve('../config.json'), null);
    assert.equal(library.resolve('..\\config.json'), null);
    assert.equal(library.resolve('sub/other.lrc'), null);
    assert.equal(library.resolve('C:\\Windows\\win.lrc'), null);
    assert.equal(library.resolve('notes.txt'), null);
    assert.notEqual(library.resolve('abc123.lrc'), null);
  });
});

test('saving an edit drops the marker, so nothing may overwrite it again', async () => {
  await withLibrary(async (library, dir) => {
    await library.store({ videoId: 'abc123', track: 'A', lines: LINES });

    const edited = await library.read('abc123.lrc');
    assert.equal(edited.managed, true);

    assert.equal(await library.write('abc123.lrc', `${edited.text}[02:00.00]Korrektur\n`), true);

    const raw = await fs.readFile(path.join(dir, 'abc123.lrc'), 'utf8');
    assert.equal(raw.includes(MANAGED_MARKER), false, 'Marke muss weg sein');

    // The point of dropping it: a later fetch must now bounce off.
    assert.equal(await library.store({ videoId: 'abc123', track: 'B', lines: LINES }), false);
  });
});

test('write refuses text no player could use', async () => {
  await withLibrary(async (library) => {
    await library.store({ videoId: 'abc123', track: 'A', lines: LINES });
    assert.equal(await library.write('abc123.lrc', 'nur Text, keine Zeitmarken'), false);
    assert.equal((await library.read('abc123.lrc')).text.includes('[00:00.00]'), true);
  });
});

test('remove protects a hand-made file until it is forced', async () => {
  await withLibrary(async (library, dir) => {
    const file = path.join(dir, 'eigenes.lrc');
    await fs.writeFile(file, '[00:00.00]Meine Fassung\n', 'utf8');

    assert.equal(await library.remove('eigenes.lrc'), 'protected');
    assert.equal((await library.read('eigenes.lrc')).text.includes('Meine Fassung'), true);

    assert.equal(await library.remove('eigenes.lrc', { force: true }), 'deleted');
    assert.equal(await library.read('eigenes.lrc'), null);
  });
});

test('remove hands the file to the trash hook rather than unlinking it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overtone-lyrics-'));
  try {
    const trashed = [];
    const library = new LyricsLibrary({
      directory: dir,
      logger: QUIET,
      trash: async (file) => {
        trashed.push(file);
      },
    });
    await library.store({ videoId: 'abc123', track: 'A', lines: LINES });

    assert.equal(await library.remove('abc123.lrc'), 'deleted');
    assert.deepEqual(trashed, [path.join(dir, 'abc123.lrc')]);
    assert.notEqual(await library.read('abc123.lrc'), null, 'der Hook loescht, nicht wir');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('formatTimestamp matches the LRC form players expect', () => {
  assert.equal(formatTimestamp(0), '[00:00.00]');
  assert.equal(formatTimestamp(5.5), '[00:05.50]');
  assert.equal(formatTimestamp(61.25), '[01:01.25]');
  assert.equal(formatTimestamp(-3), '[00:00.00]', 'negative Zeiten werden geklemmt');
});

test('safeName strips only what Windows rejects', () => {
  assert.equal(safeName('Daft Punk - Instant Crush'), 'Daft Punk - Instant Crush');
  assert.equal(safeName('AC/DC: Back in Black'), 'ACDC Back in Black');
  assert.equal(safeName('a'.repeat(200)).length, 120);
});

test('the marker that guards your edits is present in written files', async () => {
  await withLibrary(async (library, dir) => {
    await library.store({ videoId: 'a', track: 'A', lines: LINES });
    const raw = await fs.readFile(path.join(dir, 'a.lrc'), 'utf8');
    assert.ok(raw.includes(MANAGED_MARKER));
  });
});
