'use strict';

/**
 * The manifest is the only thing a plugin author writes that the window then
 * renders, so every rule that keeps a bad one out is worth a test — especially
 * the ones that must reject. A plugin folder is user-supplied input.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseManifest,
  pick,
  defaults,
  coerce,
  MAX_FIELDS,
  MAX_OPTIONS,
  MAX_LABEL,
} = require('../src/plugins/manifest');

/** A manifest that should always be accepted, to vary one thing at a time. */
const GOOD = {
  engine: 1,
  id: 'obs-overlay',
  name: { en: 'OBS overlay', de: 'OBS-Overlay' },
  surface: true,
  settings: [
    { type: 'switch', key: 'showLyrics', default: true, label: { en: 'Show the lyric line' } },
    { type: 'number', key: 'port', default: 8788, min: 1024, max: 65535, label: { en: 'Port' } },
    {
      type: 'choice',
      key: 'style',
      default: 'card',
      options: ['card', 'bar', 'minimal'],
      label: { en: 'Style' },
    },
  ],
};

const json = (patch) => JSON.stringify({ ...GOOD, ...patch });

test('a well-formed manifest is accepted whole', () => {
  const result = parseManifest(json(), { id: 'obs-overlay' });
  assert.equal(result.problem, undefined);
  assert.equal(result.manifest.id, 'obs-overlay');
  assert.equal(result.manifest.settings.length, 3);
});

test('a manifest claiming an id other than its folder is refused', () => {
  // Otherwise one plugin could read and overwrite another's stored settings
  // just by naming it.
  const result = parseManifest(json({ id: 'obs-overlay' }), { id: 'something-else' });
  assert.match(result.problem, /folder/);
});

test('main may not point outside the plugin folder', () => {
  for (const main of ['../../../etc/passwd', 'sub/main.js', '..\\main.js']) {
    const result = parseManifest(json({ surface: false, main }), { id: 'obs-overlay' });
    assert.equal(typeof result.problem, 'string', `${main} kam durch`);
  }
  assert.equal(parseManifest(json({ surface: false, main: 'main.js' }), { id: 'obs-overlay' }).problem, undefined);
});

test('a plugin that is neither a surface nor has code is refused', () => {
  const result = parseManifest(json({ surface: false }), { id: 'obs-overlay' });
  assert.match(result.problem, /neither/);
});

test('broken input is reported rather than thrown', () => {
  // A plugin that cannot be read must appear in the list as broken, with the
  // reason beside it — not take the scan down and hide the ones that are fine.
  for (const raw of ['', '{', 'null', '[]', '"a string"', '123']) {
    const result = parseManifest(raw, { id: 'obs-overlay' });
    assert.equal(typeof result.problem, 'string', `${JSON.stringify(raw)} warf oder kam durch`);
  }
});

test('every schema rule that would break the renderer is enforced', () => {
  const bad = [
    [{ type: 'nonesuch', key: 'x', default: 1 }, /type/],
    [{ type: 'switch', default: true }, /key/],
    [{ type: 'switch', key: 'x' }, /default/],
    [{ type: 'range', key: 'x', default: 5 }, /min and max/],
    [{ type: 'choice', key: 'x', default: 'a' }, /options/],
    [{ type: 'choice', key: 'x', default: 'a', options: [] }, /options/],
  ];
  for (const [field, expected] of bad) {
    const result = parseManifest(json({ settings: [field] }), { id: 'obs-overlay' });
    assert.match(result.problem, expected, JSON.stringify(field));
  }

  const twice = [
    { type: 'switch', key: 'same', default: true },
    { type: 'switch', key: 'same', default: false },
  ];
  assert.match(parseManifest(json({ settings: twice }), { id: 'obs-overlay' }).problem, /two fields/);
});

test('a manifest cannot flood the window with fields', () => {
  const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({
    type: 'switch',
    key: `k${i}`,
    default: false,
  }));
  assert.match(parseManifest(json({ settings: many }), { id: 'obs-overlay' }).problem, /max/);
});

test('a note needs neither key nor default', () => {
  const result = parseManifest(
    json({ settings: [{ type: 'note', text: { en: 'Point OBS at {url}' } }] }),
    { id: 'obs-overlay' },
  );
  assert.equal(result.problem, undefined);
});

test('a plugin string falls back in the open rather than vanishing', () => {
  assert.equal(pick({ en: 'Overlay', de: 'Overlay-Fenster' }, 'de'), 'Overlay-Fenster');
  assert.equal(pick({ en: 'Overlay' }, 'ru'), 'Overlay', 'ohne Übersetzung: Englisch');
  assert.equal(pick({ pl: 'Nakładka' }, 'ru'), 'Nakładka', 'auch ohne Englisch noch etwas');
  assert.equal(pick('plain', 'de'), 'plain');
  assert.equal(pick(undefined, 'de'), '');
  assert.equal(pick(42, 'de'), '');
});

test('defaults come straight off the schema', () => {
  assert.deepEqual(defaults(GOOD.settings), { showLyrics: true, port: 8788, style: 'card' });
  assert.deepEqual(defaults([{ type: 'note', text: 'x' }]), {}, 'eine Notiz hält nichts');
  assert.deepEqual(defaults(undefined), {});
});

test('stored values are forced into the shape the schema promised', () => {
  // plugins.json is editable by hand and the window is one IPC call from
  // anywhere, so a value's type is decided here rather than trusted.
  const out = coerce(GOOD.settings, {
    showLyrics: 'yes',
    port: '70000',
    style: 'nonesuch',
  });

  assert.equal(out.showLyrics, true);
  assert.equal(out.port, 65535, 'auf das Maximum begrenzt');
  assert.equal(out.style, 'card', 'unbekannte Auswahl fällt auf den Standard zurück');
});

test('a missing or unusable value becomes the default, never undefined', () => {
  // A plugin was promised the key exists; handing it undefined would push the
  // problem into somebody else's code.
  const out = coerce(GOOD.settings, {});
  assert.deepEqual(out, defaults(GOOD.settings));

  const junk = coerce(GOOD.settings, { port: 'abc', style: 42 });
  assert.equal(junk.port, 8788);
  assert.equal(junk.style, 'card');
});

test('coerce ignores anything the schema did not declare', () => {
  const out = coerce(GOOD.settings, { showLyrics: true, evil: 'rm -rf' });
  assert.equal('evil' in out, false);
});

test('a polluted prototype cannot smuggle a value through', () => {
  // config.js's sanitise() uses `in`, which walks the prototype chain; this one
  // must not, or Object.prototype.port would become a setting.
  Object.prototype.port = 1;
  try {
    const out = coerce(GOOD.settings, {});
    assert.equal(out.port, 8788, 'der Standard, nicht der geschmuggelte Wert');
  } finally {
    delete Object.prototype.port;
  }
});

// --------------------------------------------- what the attackers went for

test('a setting key cannot reach the prototype', () => {
  // out[field.key] = … is a plain assignment, so "__proto__" would write
  // through the object instead of into it, and every later plugin would
  // inherit whatever was put there.
  for (const key of ['__proto__', '_hidden', 'constructor', 'prototype', '1st', 'a-b', 'a b', '', 'x'.repeat(41)]) {
    const result = parseManifest(json({ settings: [{ type: 'switch', key, default: true }] }), {
      id: 'obs-overlay',
    });
    assert.match(result.problem, /key/, JSON.stringify(key) + ' kam durch');
  }
  assert.equal(
    parseManifest(json({ settings: [{ type: 'switch', key: 'showLyrics', default: true }] }), {
      id: 'obs-overlay',
    }).problem,
    undefined,
  );
});

test('a default is checked against its own field, not trusted', () => {
  // The default is the permanent fallback — coerce() hands it back whenever a
  // stored value is unusable — so an invalid one would be returned for ever.
  const bad = [
    [{ type: 'switch', key: 'a', default: 'yes' }, /true or false/],
    [{ type: 'number', key: 'a', default: 'abc', min: 0, max: 10 }, /not a number/],
    [{ type: 'number', key: 'a', default: 99, min: 0, max: 10 }, /outside/],
    [{ type: 'text', key: 'a', default: 42 }, /not text/],
    [{ type: 'choice', key: 'a', default: 'z', options: ['x', 'y'] }, /one of the options/],
  ];
  for (const [field, expected] of bad) {
    assert.match(
      parseManifest(json({ settings: [field] }), { id: 'obs-overlay' }).problem,
      expected,
      JSON.stringify(field),
    );
  }
});

test('a number without bounds is refused, like a range', () => {
  // Without them nothing downstream can clamp it, and it is a text box that
  // happens to hold digits.
  assert.match(
    parseManifest(json({ settings: [{ type: 'number', key: 'a', default: 1 }] }), { id: 'obs-overlay' }).problem,
    /without min and max/,
  );
  assert.match(
    parseManifest(json({ settings: [{ type: 'number', key: 'a', default: 5, min: 10, max: 10 }] }), { id: 'obs-overlay' }).problem,
    /min is not below max/,
  );
});

test('coerce reads the declared type, never the type of the default', () => {
  // Reading it off the default makes the default the authority on its own
  // validity: a choice whose stored value is a number would take the number
  // path and skip the membership check entirely.
  const schema = [{ type: 'choice', key: 'style', default: 'card', options: ['card', 'bar'] }];

  assert.equal(coerce(schema, { style: 42 }).style, 'card');
  assert.equal(coerce(schema, { style: 'bar' }).style, 'bar');
  assert.equal(coerce(schema, { style: ' bar ' }).style, 'bar', 'getrimmt');
  assert.equal(coerce(schema, { style: 'nonesuch' }).style, 'card');

  // And a switch stays a boolean whatever is stored.
  const flag = [{ type: 'switch', key: 'on', default: false }];
  assert.equal(coerce(flag, { on: 'false' }).on, true, 'jede nicht-leere Zeichenkette ist wahr');
  assert.equal(coerce(flag, { on: 0 }).on, false);
});

test('a label or a list that would break the layout is refused', () => {
  assert.match(
    parseManifest(json({ settings: [{ type: 'switch', key: 'a', default: true, label: { en: 'x'.repeat(MAX_LABEL + 1) } }] }), { id: 'obs-overlay' }).problem,
    /label/,
  );

  const many = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => 'o' + i);
  assert.match(
    parseManifest(json({ settings: [{ type: 'choice', key: 'a', default: 'o0', options: many }] }), { id: 'obs-overlay' }).problem,
    /options/,
  );
});

test('showIf must name another field, once', () => {
  const base = { type: 'switch', key: 'lyrics', default: true };

  const selfRef = [{ ...base, showIf: { key: 'lyrics', equals: true } }];
  assert.match(parseManifest(json({ settings: selfRef }), { id: 'obs-overlay' }).problem, /itself/);

  const missing = [base, { type: 'text', key: 'font', default: '', showIf: { key: 'nope' } }];
  assert.match(parseManifest(json({ settings: missing }), { id: 'obs-overlay' }).problem, /not a field/);

  // Chained conditions have no shape in the window and a cycle would hang it.
  const chained = [
    base,
    { type: 'switch', key: 'mid', default: true, showIf: { key: 'lyrics' } },
    { type: 'text', key: 'font', default: '', showIf: { key: 'mid' } },
  ];
  assert.match(parseManifest(json({ settings: chained }), { id: 'obs-overlay' }).problem, /itself conditional/);

  // Pointing forward at a plain field is fine.
  const forward = [{ type: 'text', key: 'font', default: '', showIf: { key: 'lyrics' } }, base];
  assert.equal(parseManifest(json({ settings: forward }), { id: 'obs-overlay' }).problem, undefined);
});

test('text that would rewrite the words around it is stripped', () => {
  // A plugin's name is drawn in Overtone's own window beside Overtone's own
  // sentences. A right-to-left override there can visually reverse the line it
  // sits in, which is a cheap way to make a card claim something we never said.
  for (const code of [0x202e, 0x200e, 0x2066, 0x0007, 0x009f, 0x001f]) {
    const text = 'a' + String.fromCharCode(code) + 'b';
    assert.equal(pick(text, 'en'), 'ab', 'U+' + code.toString(16) + ' blieb stehen');
  }
  // Ordinary text, including scripts and punctuation, is untouched.
  assert.equal(pick('Overlay – Größe · 日本語', 'en'), 'Overlay – Größe · 日本語');
});

// ------------------------------------------------- finding them on disk

const fsp = require('node:fs/promises');
const os = require('node:os');
const nodePath = require('node:path');

const { PluginRegistry } = require('../src/plugins/registry');
const { PluginStore } = require('../src/plugins/store');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

/** Two plugin roots and a store, thrown away afterwards. */
async function withRoots(run) {
  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'overtone-plug-'));
  const userDir = nodePath.join(root, 'user');

  const store = new PluginStore(nodePath.join(root, 'plugins.json'), QUIET);
  const registry = new PluginRegistry({ userDir, store, logger: QUIET });

  /** Drop a plugin folder into the one root there is. */
  const put = async (_where, id, manifest) => {
    const dir = nodePath.join(userDir, id);
    await fsp.mkdir(dir, { recursive: true });
    if (manifest !== null) {
      await fsp.writeFile(
        nodePath.join(dir, 'plugin.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      );
    }
    return dir;
  };

  try {
    await run({ registry, store, put, root, userDir });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const MANIFEST = (id, extra = {}) => ({
  engine: 1,
  id,
  name: { en: id },
  surface: true,
  settings: [{ type: 'switch', key: 'showLyrics', default: true, label: { en: 'Lyrics' } }],
  ...extra,
});

test('a plugin folder is found and described in the asked language', async () => {
  await withRoots(async ({ registry, put }) => {
    await put('user', 'my-overlay', {
      ...MANIFEST('my-overlay'),
      name: { en: 'My overlay', de: 'Mein Overlay' },
      description: { en: 'Shows the song' },
    });
    await registry.scan();

    const [plugin] = registry.describe('de');
    assert.equal(plugin.name, 'Mein Overlay');
    assert.equal(plugin.problem, null);
    assert.equal(plugin.enabled, false, 'nichts läuft, weil es installiert wurde');
    assert.deepEqual(plugin.values, { showLyrics: true });
  });
});

test('a broken plugin is listed as broken rather than left out', async () => {
  // Silently missing is the worst outcome: the author changes something, it
  // vanishes from the panel, and nothing anywhere says why.
  await withRoots(async ({ registry, put }) => {
    await put('user', 'good-one', MANIFEST('good-one'));
    await put('user', 'bad-json', '{ not json');
    await put('user', 'no-manifest', null);
    await registry.scan();

    const byId = Object.fromEntries(registry.describe('en').map((p) => [p.id, p]));
    assert.equal(byId['good-one'].problem, null);
    assert.match(byId['bad-json'].problem, /JSON/);
    assert.match(byId['no-manifest'].problem, /no plugin.json/);
    assert.equal(Object.keys(byId).length, 3, 'alle drei tauchen auf');
  });
});

test('a folder already there is never overwritten by an example', () => {
  // has() is what the add-an-example handler asks before copying. Whatever
  // somebody has in their own folder is theirs, even when it shares a name.
  const registry = new PluginRegistry({ userDir: 'C:/nowhere', store: new PluginStore('C:/none.json', QUIET), logger: QUIET });
  registry.plugins.set('overlay', { id: 'overlay', dir: 'x', manifest: null, problem: 'broken' });

  assert.equal(registry.has('overlay'), true, 'auch ein kaputtes zählt als vorhanden');
  assert.equal(registry.has('something-else'), false);
});

test('a manifest too large to be one is refused without reading it', async () => {
  await withRoots(async ({ registry, put, userDir }) => {
    await put('user', 'huge', MANIFEST('huge'));
    await fsp.writeFile(nodePath.join(userDir, 'huge', 'plugin.json'), 'x'.repeat(70000));
    await registry.scan();

    assert.match(registry.describe('en')[0].problem, /max/);
  });
});

test('a missing plugins folder is not an error', async () => {
  await withRoots(async ({ registry }) => {
    await registry.scan();
    assert.deepEqual(registry.describe('en'), []);
  });
});

test('stored values survive a manifest that changed underneath them', async () => {
  await withRoots(async ({ registry, store, put }) => {
    await put('user', 'shifty', {
      ...MANIFEST('shifty'),
      settings: [{ type: 'number', key: 'size', default: 20, min: 10, max: 40 }],
    });
    await registry.scan();
    store.setValue('shifty', 'size', 35);

    // The author tightens the bound in a later version.
    await put('user', 'shifty', {
      ...MANIFEST('shifty'),
      settings: [{ type: 'number', key: 'size', default: 20, min: 10, max: 30 }],
    });
    await registry.scan();

    assert.equal(registry.describe('en')[0].values.size, 30, 'auf die neue Grenze gezogen');
  });
});

test('the store keeps plugins apart and survives a corrupted file', async () => {
  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'overtone-store-'));
  try {
    const file = nodePath.join(root, 'plugins.json');
    const store = new PluginStore(file, QUIET);

    store.setEnabled('a', true);
    store.setValue('a', 'size', 12);
    store.setValue('b', 'size', 99);

    const reopened = new PluginStore(file, QUIET);
    assert.equal(reopened.isEnabled('a'), true);
    assert.equal(reopened.isEnabled('b'), false);
    assert.equal(reopened.valuesFor('a').size, 12);
    assert.equal(reopened.valuesFor('b').size, 99);

    // A half-written file must cost settings, not the app.
    await fsp.writeFile(file, '{ broken');
    const broken = new PluginStore(file, QUIET);
    assert.equal(broken.isEnabled('a'), false);
    assert.deepEqual(broken.valuesFor('a'), {});
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a plugin id that names something on the prototype is still its own entry', () => {
  const store = new PluginStore(nodePath.join(os.tmpdir(), 'overtone-none.json'), QUIET);
  assert.equal(store.isEnabled('constructor'), false);
  assert.deepEqual(store.valuesFor('toString'), {});
});

// --------------------------------------------- what a surface is told

const { overlayPayload, changed } = require('../src/plugins/feed');

const SNAP = {
  now: {
    title: 'DJ SKIBA - KRĘCISZ MNIE',
    artist: 'DJ SKIBA',
    thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
    source: 'youtube',
    duration: 187.4,
    position: 42.8,
    paused: false,
  },
  lyrics: { status: 'found', line: 'a line', origin: 'library' },
  // Things that must never reach a stream, present exactly as the real
  // snapshot has them.
  discordUser: 'yourshika',
  lastError: 'Discord: something went wrong',
  transcription: { queue: ['a private song'] },
  version: '2.3.2',
};

const CFG = { privacyMode: false, lyricsEnabled: true, lyricsMusicOnly: false };

test('the overlay payload is an allowlist, not a filtered snapshot', () => {
  // Asserted literally so a field added to statusSnapshot() cannot arrive on
  // somebody's stream by simply existing.
  const payload = overlayPayload({ snapshot: SNAP, config: CFG, lines: null, now: 1000 });

  assert.deepEqual(
    Object.keys(payload).sort(),
    ['artist', 'at', 'cover', 'duration', 'mode', 'paused', 'playing', 'position', 'privacy', 'source', 'title'].sort(),
  );

  const asText = JSON.stringify(payload);
  for (const secret of ['yourshika', 'something went wrong', 'a private song', '2.3.2']) {
    assert.equal(asText.includes(secret), false, secret + ' ist durchgekommen');
  }
});

test('private mode blanks the overlay exactly as it blanks Discord', () => {
  const payload = overlayPayload({
    snapshot: SNAP,
    config: { ...CFG, privacyMode: true },
    lines: [{ time: 1, text: 'x' }],
    now: 1000,
  });

  assert.equal(payload.privacy, true);
  assert.equal(payload.title, undefined);
  assert.equal(payload.artist, undefined);
  assert.equal(payload.cover, undefined);
  assert.equal(payload.mode, 'none');
  // The bar may still move: that it is playing was never the secret.
  assert.equal(payload.duration, 187);
});

test('nothing playing is a state the page renders, not an error', () => {
  const payload = overlayPayload({ snapshot: { now: null }, config: CFG, lines: null, now: 5 });
  assert.equal(payload.playing, false);
  assert.equal(payload.mode, 'none');
});

test('cues travel once per track, capped, with the anchor', () => {
  const lines = Array.from({ length: 500 }, (_, i) => ({ time: i, text: 'x'.repeat(400) }));
  const payload = overlayPayload({ snapshot: SNAP, config: CFG, lines, now: 9000 });

  assert.equal(payload.mode, 'timed');
  assert.equal(payload.cues.length, 400, 'gedeckelt');
  assert.equal(payload.cues[0].text.length, 300, 'jede Zeile gedeckelt');
  assert.equal(payload.at, 9000);
  assert.equal(payload.position, 43, 'ganze Sekunden');
});

test('subtitles are one line and say so, because there is nothing to read ahead', () => {
  const payload = overlayPayload({
    snapshot: { ...SNAP, lyrics: { status: 'captions', line: 'right now' } },
    config: CFG,
    lines: null,
    now: 1,
  });
  assert.equal(payload.mode, 'caption');
  assert.equal(payload.line, 'right now');
  assert.equal(payload.cues, undefined);
});

test('lyrics off, or music-only on a plain video, means no lyric half at all', () => {
  const lines = [{ time: 1, text: 'x' }];
  assert.equal(
    overlayPayload({ snapshot: SNAP, config: { ...CFG, lyricsEnabled: false }, lines, now: 1 }).mode,
    'none',
  );
  assert.equal(
    overlayPayload({ snapshot: SNAP, config: { ...CFG, lyricsMusicOnly: true }, lines, now: 1 }).mode,
    'none',
  );
});

test('artwork from anywhere but the two known hosts is dropped', () => {
  for (const bad of ['http://evil/x.jpg', 'javascript:alert(1)', 'https://i.ytimg.com.evil/x']) {
    const payload = overlayPayload({
      snapshot: { ...SNAP, now: { ...SNAP.now, thumbnail: bad } },
      config: CFG,
      lines: null,
      now: 1,
    });
    assert.equal(payload.cover, '', bad + ' kam durch');
  }
});

test('the song simply advancing is not a change worth sending', () => {
  // The page has the anchor and runs its own clock, so a position that moved by
  // exactly the elapsed time tells it nothing it did not already know.
  const a = overlayPayload({ snapshot: SNAP, config: CFG, lines: null, now: 1000 });
  const later = { ...SNAP, now: { ...SNAP.now, position: 47.8 } };
  const b = overlayPayload({ snapshot: later, config: CFG, lines: null, now: 6000 });
  assert.equal(changed(a, b), false);

  // A seek is.
  const jumped = { ...SNAP, now: { ...SNAP.now, position: 120 } };
  assert.equal(changed(a, overlayPayload({ snapshot: jumped, config: CFG, lines: null, now: 6000 })), true);

  // And so is a pause, or a new song.
  const paused = { ...SNAP, now: { ...SNAP.now, paused: true } };
  assert.equal(changed(a, overlayPayload({ snapshot: paused, config: CFG, lines: null, now: 1000 })), true);
  assert.equal(changed(null, a), true);
});

// ------------------------------------------------- the door, under attack

const { SurfaceServer } = require('../src/plugins/surface');

/** A running server over one surface plugin, torn down afterwards. */
async function withServer(run) {
  const root = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'overtone-surf-'));
  const dir = nodePath.join(root, 'plugins', 'demo');
  await fsp.mkdir(nodePath.join(dir, 'public'), { recursive: true });
  await fsp.writeFile(nodePath.join(dir, 'public', 'index.html'), '<!doctype html><p>hi');
  await fsp.writeFile(
    nodePath.join(dir, 'plugin.json'),
    JSON.stringify({ engine: 1, id: 'demo', name: { en: 'Demo' }, surface: true }),
  );

  const store = new PluginStore(nodePath.join(root, 'plugins.json'), QUIET);
  store.setEnabled('demo', true);
  const registry = new PluginRegistry({
    userDir: nodePath.join(root, 'plugins'),
    store,
    logger: QUIET,
  });
  await registry.scan();

  const server = new SurfaceServer({
    registry,
    payload: () => ({ playing: true, title: 'A song', at: 1 }),
    logger: QUIET,
  });
  // Port 0 lets the OS pick, so a busy machine cannot make this flaky.
  await server.start(0);

  /** A raw request, so the Host header can be wrong on purpose. */
  const ask = (path, headers = {}) =>
    new Promise((resolve) => {
      const req = require('node:http').request(
        {
          host: '127.0.0.1',
          port: server.port,
          path,
          method: headers.method || 'GET',
          headers: { host: `127.0.0.1:${server.port}`, ...headers },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
      req.end();
    });

  try {
    await run({ server, ask, dir, root });
  } finally {
    await server.stop();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('a page with the address is served, and everything else is not', async () => {
  await withServer(async ({ server, ask }) => {
    const good = await ask(`/s/${server.token}/demo/`);
    assert.equal(good.status, 200);
    assert.match(good.body, /hi/);
    assert.equal(good.headers['x-content-type-options'], 'nosniff');
    assert.equal(good.headers['referrer-policy'], 'no-referrer');
    assert.equal(good.headers['access-control-allow-origin'], undefined, 'nichts darf das lesen');

    assert.equal((await ask('/')).status, 404);
    assert.equal((await ask('/s/')).status, 404);
    assert.equal((await ask(`/s/${server.token}/nonesuch/`)).status, 404);
  });
});

test('a wrong-length token is refused rather than crashing the agent', async () => {
  // timingSafeEqual throws RangeError on unequal lengths, and one such throw in
  // an http listener would take the whole tray agent down.
  await withServer(async ({ ask }) => {
    for (const token of ['a', '', 'x'.repeat(200), '../../etc']) {
      const res = await ask(`/s/${encodeURIComponent(token)}/demo/`);
      assert.equal(res.status, 404, JSON.stringify(token));
    }
  });
});

test('a request that did not ask for 127.0.0.1 by name is refused', async () => {
  // This is what makes "it only works on this computer" true: a page on the
  // internet can point a name at 127.0.0.1, but cannot forge this header.
  await withServer(async ({ server, ask }) => {
    const res = await ask(`/s/${server.token}/demo/`, { host: 'overlay.evil.com' });
    assert.equal(res.status, 403);
  });
});

test('a page trying its luck from another origin is refused', async () => {
  await withServer(async ({ server, ask }) => {
    const res = await ask(`/s/${server.token}/demo/`, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    // No Origin at all is a top-level navigation, which is how OBS opens it.
    assert.equal((await ask(`/s/${server.token}/demo/`)).status, 200);
  });
});

test('nothing outside the plugin public folder can be reached', async () => {
  await withServer(async ({ server, ask, root }) => {
    await fsp.writeFile(nodePath.join(root, 'secret.html'), 'private');

    for (const attempt of [
      '../../secret.html',
      '..%2f..%2fsecret.html',
      '%2e%2e%2f%2e%2e%2fsecret.html',
      'sub/index.html',
      'index.html%00.png',
    ]) {
      const res = await ask(`/s/${server.token}/demo/${attempt}`);
      assert.equal(res.status, 404, attempt);
      assert.equal(res.body.includes('private'), false, attempt + ' hat gelesen');
    }
  });
});

test('a file type the surface never declared is not served', async () => {
  await withServer(async ({ server, ask, dir }) => {
    await fsp.writeFile(nodePath.join(dir, 'public', 'notes.txt'), 'text');
    assert.equal((await ask(`/s/${server.token}/demo/notes.txt`)).status, 404);
  });
});

test('the feed opens, sends at once, and closes with the server', async () => {
  await withServer(async ({ server }) => {
    const chunks = [];
    const res = await new Promise((resolve) => {
      require('node:http')
        .get(
          {
            host: '127.0.0.1',
            port: server.port,
            path: `/s/${server.token}/demo/feed`,
            headers: { host: `127.0.0.1:${server.port}` },
          },
          resolve,
        )
        .end();
    });
    res.on('data', (c) => chunks.push(c.toString()));

    await new Promise((r) => setTimeout(r, 60));
    assert.match(chunks.join(''), /A song/, 'ein Bild sofort, nicht erst bei der nächsten Änderung');
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(server.clients.size, 1);

    res.destroy();
  });
});

test('a new address retires the old one', async () => {
  await withServer(async ({ server, ask }) => {
    const old = server.token;
    assert.equal((await ask(`/s/${old}/demo/`)).status, 200);

    // A fresh port, because the old one is still in the kernel's hands for a
    // moment after close and this test is about the token, not the number.
    await server.stop();
    await server.start(0);

    assert.notEqual(server.token, old);
    assert.equal((await ask(`/s/${old}/demo/`)).status, 404, 'die alte Adresse ist tot');
    assert.equal((await ask(`/s/${server.token}/demo/`)).status, 200, 'die neue lebt');
  });
});

test('a method other than GET or HEAD is refused', async () => {
  await withServer(async ({ server, ask }) => {
    assert.equal((await ask(`/s/${server.token}/demo/`, { method: 'POST' })).status, 405);
    assert.equal((await ask(`/s/${server.token}/demo/`, { method: 'HEAD' })).status, 200);
  });
});

test('no plugin manifest hides inside the app source', () => {
  // The bundled plugins live in agent/plugins, outside every root the i18n
  // sweep walks. Moving one under agent/src would break two of those guarantees
  // at once — and quietly, in a suite that is about translations. This turns
  // that into a red test with a name that says what happened.
  for (const root of ['src', 'ui', nodePath.join('..', 'extension', 'src')]) {
    const found = [];
    const walk = (dir) => {
      for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'plugin.json') found.push(full);
      }
    };
    walk(nodePath.join(__dirname, '..', root));
    assert.deepEqual(found, [], `${root} enthält ein Plugin-Manifest`);
  }
});

test('the example overlay is a manifest this app would accept from anyone', () => {
  // It travels with Overtone but is not installed by it, and it goes through
  // exactly the door a folder somebody dropped in goes through. If it needed an
  // exception, the door would be the wrong shape.
  const raw = require('node:fs').readFileSync(
    nodePath.join(__dirname, '..', '..', 'plugins', 'overlay', 'plugin.json'),
    'utf8',
  );
  const result = parseManifest(raw, { id: 'overlay' });

  assert.equal(result.problem, undefined);
  assert.equal(result.manifest.surface, true);
  assert.equal(result.manifest.main, undefined, 'eine Oberfläche führt keinen Code im Agenten aus');

  // Every label carries at least English, or the panel would draw a blank.
  for (const field of result.manifest.settings) {
    const text = field.type === 'note' ? field.text : field.label;
    assert.equal(typeof pick(text, 'en'), 'string');
    assert.notEqual(pick(text, 'en'), '', `${field.key || 'note'} ohne englischen Text`);
  }
});

test('the address survives a restart, and only a deliberate act changes it', async () => {
  // The complaint that produced this: a token minted on every start meant every
  // Browser Source in OBS pointed at a dead URL the next morning.
  await withServer(async ({ server }) => {
    const keep = server.token;
    await server.stop();

    await server.start(0, keep);
    assert.equal(server.token, keep, 'dieselbe Marke nach dem Neustart');

    // Passing nothing is what the New address button does: forget it, and the
    // next start mints another.
    await server.stop();
    await server.start(0);
    assert.notEqual(server.token, keep);

    // And the address itself carries no settings, so it never changes when one
    // of them does.
    assert.equal(server.addressFor('demo').includes('?'), false);
    assert.equal(server.registry.surfaces().length, 1);
  });
});

test('sync leaves a running server alone unless the port or the address changed', async () => {
  await withServer(async ({ server }) => {
    const { token, port } = server;

    await server.sync(port, token);
    assert.equal(server.token, token, 'kein Neustart, keine neue Marke');

    // A different token is a rotation and does mean a restart.
    await server.sync(port, 'a-deliberately-different-token');
    assert.equal(server.token, 'a-deliberately-different-token');
  });
});

test('a setting changed in the panel reaches a page that is already open', async () => {
  // The other half of a stable address: if the URL no longer carries the
  // settings, they have to arrive some other way or moving a slider would do
  // nothing until the source was pasted again.
  await withServer(async ({ server }) => {
    let style = 'card';
    server.payload = () => ({ playing: true, title: 'A song', at: 1, settings: { style } });

    const frames = [];
    const res = await new Promise((resolve) => {
      require('node:http')
        .get(
          {
            host: '127.0.0.1',
            port: server.port,
            path: `/s/${server.token}/demo/feed`,
            headers: { host: `127.0.0.1:${server.port}` },
          },
          resolve,
        )
        .end();
    });
    res.on('data', (chunk) => frames.push(chunk.toString()));
    await new Promise((r) => setTimeout(r, 60));

    assert.match(frames.join(''), /"style":"card"/);

    style = 'bar';
    server.publish();
    await new Promise((r) => setTimeout(r, 60));
    assert.match(frames.at(-1), /"style":"bar"/);

    res.destroy();
  });
});
