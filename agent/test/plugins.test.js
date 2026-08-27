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
