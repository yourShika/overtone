'use strict';

/**
 * Translation.
 *
 * English is the reference: every other locale must carry exactly its keys, and
 * a test enforces that. A missing key would otherwise be invisible until
 * someone switching language met a raw identifier on screen.
 *
 * An unknown key returns the key itself rather than an empty string. Silence
 * looks like a layout bug; the identifier at least says what is missing.
 *
 * Adding a language means one file in `locales/` and one entry in `LANGUAGES`.
 */

const en = require('./locales/en');

const DICTIONARIES = {
  en,
  de: require('./locales/de'),
  pl: require('./locales/pl'),
  ru: require('./locales/ru'),
  es: require('./locales/es'),
};

/** Shown in the language picker, in their own language. */
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pl', label: 'Polski' },
  { code: 'ru', label: 'Русский' },
  { code: 'es', label: 'Español' },
];

let current = 'en';

function setLocale(code) {
  current = DICTIONARIES[code] ? code : 'en';
  return current;
}

function getLocale() {
  return current;
}

/**
 * Translate a key, substituting `{name}` placeholders.
 *
 * Falls back through the active locale, then English, then the key itself. A
 * placeholder with no matching value is left as written, so a typo in a
 * translation shows up rather than quietly emptying the sentence.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @param {string} [locale] override the active locale
 * @returns {string}
 */
function t(key, vars, locale) {
  const dictionary = DICTIONARIES[locale || current] || en;
  const template = dictionary[key] ?? en[key] ?? key;

  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** The whole dictionary, for handing to a renderer in one go. */
function dictionary(locale) {
  return { ...en, ...(DICTIONARIES[locale || current] || {}) };
}

/**
 * Best guess from the operating system, used only when nothing is configured.
 * English if we cannot do better — the default this project ships with.
 */
function detect(systemLocale) {
  const code = String(systemLocale || '').slice(0, 2).toLowerCase();
  return DICTIONARIES[code] ? code : 'en';
}

module.exports = { t, setLocale, getLocale, dictionary, detect, LANGUAGES, DICTIONARIES };
