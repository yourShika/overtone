'use strict';

/**
 * Several pages from one plugin.
 *
 * The server already served any file under public/, so the rules that matter
 * are the ones that decide what a manifest may claim — a view naming a file the
 * server would refuse is a plugin that looks installed and hands out an address
 * that answers nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseManifest } = require('../src/plugins/manifest');
const { SurfaceServer } = require('../src/plugins/surface');
const { overlayPayload } = require('../src/plugins/feed');

const BASE = {
  engine: 1,
  id: 'demo',
  surface: true,
  name: 'Demo',
};

const parse = (extra) => parseManifest(JSON.stringify({ ...BASE, ...extra }), { id: 'demo' });

test('a plugin that declares nothing still has one page', () => {
  const { manifest, problem } = parse({});
  assert.equal(problem, undefined);
  assert.deepEqual(manifest.views, [{ id: 'main', file: 'index.html', name: 'Demo' }]);
});

test('declared pages come through in order', () => {
  const { manifest, problem } = parse({
    views: [
      { id: 'main', file: 'index.html', name: 'Card' },
      { id: 'video', file: 'video.html', name: { en: 'Video', de: 'Video' } },
    ],
  });
  assert.equal(problem, undefined);
  assert.deepEqual(
    manifest.views.map((view) => `${view.id}:${view.file}`),
    ['main:index.html', 'video:video.html'],
  );
});

test('a page may not point outside the folder', () => {
  for (const file of [
    '../../secrets.html',
    'sub/page.html',
    'page.html/../..',
    '..\\page.html',
    'page.js',
    'page',
    '',
  ]) {
    const { problem } = parse({ views: [{ id: 'a', file, name: 'A' }] });
    assert.ok(problem, `durchgelassen: ${JSON.stringify(file)}`);
  }
});

test('two pages may not share a name', () => {
  const { problem } = parse({
    views: [
      { id: 'main', file: 'index.html', name: 'A' },
      { id: 'main', file: 'other.html', name: 'B' },
    ],
  });
  assert.match(problem, /two views/);
});

test('a page id has to survive being written into a URL', () => {
  for (const id of ['__proto__', 'a/b', 'a b', '1st', '', 'a'.repeat(40)]) {
    const { problem } = parse({ views: [{ id, file: 'index.html', name: 'A' }] });
    assert.ok(problem, `durchgelassen: ${JSON.stringify(id)}`);
  }
});

test('a setting may not name a page that does not exist', () => {
  const { problem } = parse({
    views: [{ id: 'main', file: 'index.html', name: 'A' }],
    settings: [{ type: 'switch', key: 'x', label: 'X', default: true, view: 'video' }],
  });
  assert.match(problem, /names view "video"/);
});

test('a setting naming a real page is kept', () => {
  const { manifest, problem } = parse({
    views: [
      { id: 'main', file: 'index.html', name: 'A' },
      { id: 'video', file: 'video.html', name: 'B' },
    ],
    settings: [{ type: 'switch', key: 'x', label: 'X', default: true, view: 'video' }],
  });
  assert.equal(problem, undefined);
  assert.equal(manifest.settings[0].view, 'video');
});

test('there is a limit on how many pages a plugin may claim', () => {
  const views = Array.from({ length: 9 }, (_unused, i) => ({
    id: `v${i}`,
    file: `v${i}.html`,
    name: `V${i}`,
  }));
  assert.match(parse({ views }).problem, /max 8/);
});

test('each page gets its own address, and index.html keeps the bare one', () => {
  const server = new SurfaceServer({ registry: { surfaces: () => [] }, payload: () => null });
  server.server = {};
  server.port = 8787;
  server.token = 'tok';

  assert.equal(server.addressFor('demo'), 'http://127.0.0.1:8787/s/tok/demo/');
  assert.equal(server.addressFor('demo', 'index.html'), 'http://127.0.0.1:8787/s/tok/demo/');
  assert.equal(server.addressFor('demo', 'video.html'), 'http://127.0.0.1:8787/s/tok/demo/video.html');
});

// --- what a video page needs ------------------------------------------------

const SNAP = {
  now: {
    title: 'A song',
    artist: 'Someone',
    source: 'youtube',
    duration: 200,
    position: 40,
    paused: false,
    videoId: 'dQw4w9WgXcQ',
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  },
  lyrics: {},
};
const CFG = { privacyMode: false, lyricsEnabled: true, lyricsMusicOnly: false };

test('the video id reaches a surface, shaped rather than trusted', () => {
  assert.equal(overlayPayload({ snapshot: SNAP, config: CFG, lines: null, now: 1 }).video, 'dQw4w9WgXcQ');

  // A page pastes this straight into an embed address, so anything that is not
  // an id comes through as nothing at all.
  for (const bad of ['../../evil', 'dQw4w9WgXcQ&x=1', 'short', '', null, undefined, 12345]) {
    const payload = overlayPayload({
      snapshot: { ...SNAP, now: { ...SNAP.now, videoId: bad } },
      config: CFG,
      lines: null,
      now: 1,
    });
    assert.equal(payload.video, '', `durchgelassen: ${JSON.stringify(bad)}`);
  }
});

test('private mode keeps the video id back with everything else', () => {
  const payload = overlayPayload({
    snapshot: SNAP,
    config: { ...CFG, privacyMode: true },
    lines: null,
    now: 1,
  });
  assert.equal(payload.privacy, true);
  assert.equal(payload.video, undefined);
});

// --- which names the door opens to ------------------------------------------

test('both loopback names are let in, and nothing else', () => {
  const server = new SurfaceServer({ registry: { surfaces: () => [] }, payload: () => null });
  server.port = 8787;

  assert.equal(server._hostOk('127.0.0.1:8787'), true);
  // localhost, because YouTube's embedded player refuses to run for a page
  // whose origin is a bare loopback IP — measured, not assumed.
  assert.equal(server._hostOk('localhost:8787'), true);

  for (const host of [
    'evil.example:8787',
    'localhost.evil.example:8787',
    'localhost:8788',
    '127.0.0.1',
    'localhost',
    '127.0.0.2:8787',
    '[::1]:8787',
    '',
    undefined,
  ]) {
    assert.equal(server._hostOk(host), false, `durchgelassen: ${String(host)}`);
  }
});
