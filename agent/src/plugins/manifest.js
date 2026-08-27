'use strict';

/**
 * plugin.json — the whole contract between a plugin author and the window.
 *
 * A plugin declares what it wants set; the settings window renders it. Nothing
 * a plugin writes reaches the renderer as code, which is why the schema is a
 * closed list of types rather than anything open-ended: the settings window
 * runs sandboxed under `script-src 'self'`, and it stays that way. A plugin
 * that wants a control we do not have does without, rather than being handed a
 * way to inject markup.
 *
 * Everything here is pure. No file system, no network, no Electron — so the
 * rules can be exercised in a test, including the ones that must reject.
 */

/** Bumped only when an old manifest would be misread rather than merely poorer. */
const ENGINE = 1;

/**
 * Field types, and the component each becomes in the window.
 *
 * All but `colour` render from CSS that already exists; that one needs a rule
 * of its own, which is worth saying rather than discovering later.
 */
const TYPES = {
  switch: '.switch-row',
  text: 'input[type=text]',
  number: 'input[type=number]',
  range: '.slider-row',
  choice: '.segmented (≤4 options) or .pill-row',
  colour: 'input[type=color]',
  note: '.hint',
};

/**
 * Identity on disk and in plugins.json, so it has to survive being a folder
 * name, a JSON key and part of a URL path without escaping.
 */
const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** A plugin may not declare more than this; a thousand fields is not a setting. */
const MAX_FIELDS = 40;

/**
 * Read a manifest, or say what is wrong with it in one line.
 *
 * Returns a problem rather than throwing: a broken plugin must show up in the
 * list as broken, with the reason next to it, instead of taking the scan down
 * and hiding the plugins that are fine.
 *
 * @param {string} raw       contents of plugin.json
 * @param {object} options
 * @param {string} options.id  the folder name it was found in
 * @returns {{ manifest: object }|{ problem: string }}
 */
function parseManifest(raw, { id }) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { problem: `JSON: ${err.message}` };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { problem: 'not an object' };
  }

  if (json.engine !== ENGINE) return { problem: `engine ${json.engine} is not ${ENGINE}` };
  if (typeof json.id !== 'string' || !ID.test(json.id)) return { problem: 'id' };
  // The folder is the identity. A manifest claiming a different one would let
  // a plugin read and overwrite another plugin's stored settings.
  if (json.id !== id) return { problem: `id "${json.id}" is not the folder "${id}"` };
  if (!json.name || (typeof json.name !== 'object' && typeof json.name !== 'string')) {
    return { problem: 'name' };
  }

  // Either a surface (static files served to a browser) or logic (code), and a
  // plugin may be both. One of them has to be true or there is nothing to run.
  const hasMain = typeof json.main === 'string' && json.main.length > 0;
  const hasPublic = json.surface === true;
  if (!hasMain && !hasPublic) return { problem: 'neither main nor surface' };
  if (hasMain && (json.main.includes('..') || /[\\/]/.test(json.main))) {
    return { problem: 'main must be a file name in the plugin folder' };
  }

  const settings = Array.isArray(json.settings) ? json.settings : [];
  if (settings.length > MAX_FIELDS) return { problem: `${settings.length} fields, max ${MAX_FIELDS}` };

  const seen = new Set();
  for (const field of settings) {
    if (!field || typeof field !== 'object') return { problem: 'a field is not an object' };
    if (!Object.prototype.hasOwnProperty.call(TYPES, field.type)) {
      return { problem: `type "${field.type}"` };
    }
    // A note displays and holds nothing, so it needs no key and no default.
    if (field.type === 'note') continue;

    if (typeof field.key !== 'string' || !field.key) return { problem: 'a field has no key' };
    if (seen.has(field.key)) return { problem: `two fields called "${field.key}"` };
    seen.add(field.key);

    if (!Object.prototype.hasOwnProperty.call(field, 'default')) {
      return { problem: `"${field.key}" has no default` };
    }
    if (field.type === 'range' && !(Number.isFinite(field.min) && Number.isFinite(field.max))) {
      return { problem: `"${field.key}" is a range without min and max` };
    }
    if (field.type === 'choice' && (!Array.isArray(field.options) || !field.options.length)) {
      return { problem: `"${field.key}" is a choice without options` };
    }
  }

  return { manifest: { ...json, settings } };
}

/**
 * Resolve a plugin's own localised string.
 *
 * Deliberately not a dictionary key. The app holds itself to five complete
 * locales; a plugin author cannot be, so a plugin ships what it has and this
 * falls back in the open: asked language, then English, then whatever it does
 * have, then nothing.
 */
function pick(value, locale) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value[locale] === 'string') return value[locale];
  if (typeof value.en === 'string') return value.en;
  const first = Object.values(value).find((v) => typeof v === 'string');
  return first || '';
}

/** Every declared default, as a plain object. */
function defaults(schema) {
  const out = {};
  for (const field of schema || []) {
    if (field.type !== 'note') out[field.key] = field.default;
  }
  return out;
}

/**
 * Force stored or incoming values into the shape the schema promised.
 *
 * The same rule config.js applies to its own settings, for the same reason: the
 * file is editable by hand and the window is one IPC call from anywhere, so a
 * value's type is decided here rather than trusted. Anything unrecognised falls
 * back to the declared default instead of being dropped, so a plugin never sees
 * a missing key it was told would exist.
 */
function coerce(schema, input) {
  const out = {};
  const given = input && typeof input === 'object' ? input : {};

  for (const field of schema || []) {
    if (field.type === 'note') continue;

    const fallback = field.default;
    // hasOwnProperty, not `in`: `in` walks the prototype chain, and a polluted
    // Object.prototype would otherwise smuggle keys through.
    const raw = Object.prototype.hasOwnProperty.call(given, field.key)
      ? given[field.key]
      : fallback;

    if (typeof fallback === 'boolean') {
      out[field.key] = Boolean(raw);
      continue;
    }

    if (typeof fallback === 'number') {
      let value = Number(raw);
      if (!Number.isFinite(value)) value = fallback;
      if (Number.isFinite(field.min)) value = Math.max(field.min, value);
      if (Number.isFinite(field.max)) value = Math.min(field.max, value);
      if (field.step === 1) value = Math.round(value);
      out[field.key] = value;
      continue;
    }

    let value = typeof raw === 'string' ? raw.trim() : String(fallback ?? '');
    if (field.maxLength > 0) value = value.slice(0, field.maxLength);

    // A choice may only ever hold one of its options; anything else is a
    // hand-edited file or a stale value from a manifest that changed.
    if (field.type === 'choice') {
      const allowed = field.options.map((option) =>
        option && typeof option === 'object' ? option.value : option,
      );
      if (!allowed.includes(value)) value = fallback;
    }

    out[field.key] = value;
  }

  return out;
}

module.exports = { parseManifest, pick, defaults, coerce, ENGINE, TYPES, ID, MAX_FIELDS };
