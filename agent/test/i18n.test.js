'use strict';

/**
 * Translation completeness.
 *
 * The point of these is that a gap in a translation is otherwise invisible:
 * nothing throws, nothing looks broken in development, and the first person to
 * notice is someone who switched language and met a raw key on screen. So the
 * suite compares every locale against English key by key, and checks that the
 * placeholders survived translation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { t, setLocale, dictionary, detect, LANGUAGES, DICTIONARIES } = require('../src/i18n');

const REFERENCE = DICTIONARIES.en;
const OTHERS = Object.keys(DICTIONARIES).filter((code) => code !== 'en');

test('every language in the picker has a dictionary, and the reverse', () => {
  const listed = LANGUAGES.map((l) => l.code).sort();
  assert.deepEqual(listed, Object.keys(DICTIONARIES).sort());
});

test('no locale is missing a key', () => {
  for (const code of OTHERS) {
    const missing = Object.keys(REFERENCE).filter((key) => !(key in DICTIONARIES[code]));
    assert.deepEqual(missing, [], `${code} fehlen: ${missing.join(', ')}`);
  }
});

test('no locale carries a key English does not have', () => {
  // A leftover key is a rename that was only half applied, and it will rot.
  for (const code of OTHERS) {
    const extra = Object.keys(DICTIONARIES[code]).filter((key) => !(key in REFERENCE));
    assert.deepEqual(extra, [], `${code} hat überzählige: ${extra.join(', ')}`);
  }
});

test('placeholders survive translation', () => {
  const placeholders = (text) => (String(text).match(/\{\w+\}/g) || []).sort();

  for (const code of OTHERS) {
    for (const [key, reference] of Object.entries(REFERENCE)) {
      assert.deepEqual(
        placeholders(DICTIONARIES[code][key]),
        placeholders(reference),
        `${code}/${key}: Platzhalter weichen ab`,
      );
    }
  }
});

test('nothing was left untranslated by copy-paste', () => {
  // Proper nouns and identifiers are legitimately identical everywhere; a long
  // sentence that matches English exactly is a forgotten string.
  const SHARED = new Set(['app.name', 'presence.youtube', 'presence.youtubeMusic', 'popup.name']);

  for (const code of OTHERS) {
    for (const [key, reference] of Object.entries(REFERENCE)) {
      if (SHARED.has(key)) continue;
      if (String(reference).length < 25) continue; // short labels can coincide
      assert.notEqual(
        DICTIONARIES[code][key],
        reference,
        `${code}/${key} ist noch der englische Text`,
      );
    }
  }
});

test('t substitutes placeholders', () => {
  setLocale('en');
  assert.equal(t('status.discordUser', { user: 'someone' }), 'Discord · @someone');
  assert.equal(t('wiz.step', { current: 2, total: 4 }).startsWith('Step 2 of 4'), true);
});

test('an unknown placeholder is left visible rather than blanked', () => {
  setLocale('en');
  // Losing it silently would empty the sentence with nothing to point at.
  assert.equal(t('status.discordUser', {}), 'Discord · @{user}');
});

test('an unknown key returns the key, not emptiness', () => {
  setLocale('en');
  assert.equal(t('does.not.exist'), 'does.not.exist');
});

test('a locale falls back to English for a key it lacks', () => {
  const backup = DICTIONARIES.de['app.settings'];
  delete DICTIONARIES.de['app.settings'];
  try {
    setLocale('de');
    assert.equal(t('app.settings'), REFERENCE['app.settings']);
  } finally {
    DICTIONARIES.de['app.settings'] = backup;
    setLocale('en');
  }
});

test('setLocale rejects a language we do not have', () => {
  assert.equal(setLocale('kl'), 'en');
  assert.equal(setLocale('de'), 'de');
  setLocale('en');
});

test('detect maps a system locale onto what we ship', () => {
  assert.equal(detect('de-DE'), 'de');
  assert.equal(detect('pl'), 'pl');
  assert.equal(detect('ru-RU'), 'ru');
  assert.equal(detect('es-419'), 'es');
  assert.equal(detect('ja-JP'), 'en', 'unbekannte Sprache fällt auf Englisch zurück');
  assert.equal(detect(undefined), 'en');
});

test('dictionary hands over a complete set for the renderer', () => {
  const german = dictionary('de');
  assert.deepEqual(Object.keys(german).sort(), Object.keys(REFERENCE).sort());
  assert.equal(german['nav.conn'], 'Verbindung');
});
