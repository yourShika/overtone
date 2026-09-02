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

/** What each type stores, so a default can be checked against its own field. */
const HOLDS = {
  switch: 'boolean',
  text: 'string',
  number: 'number',
  range: 'number',
  choice: 'string',
  colour: 'string',
};

/**
 * Identity on disk and in plugins.json, so it has to survive being a folder
 * name, a JSON key and part of a URL path without escaping.
 */
const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * A view's name, which becomes part of a URL path.
 *
 * Same shape as a setting key rather than the plugin id: it is written by the
 * same author in the same file, and it never has to be a folder name.
 */
const VIEW_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/**
 * A page a view points at.
 *
 * Exactly what the server will serve: one flat name, no separators, no walking
 * up. Checked here as well as there on purpose — a manifest that names a file
 * the server would refuse is a plugin that looks installed and shows a broken
 * address, and saying so at load time is the difference between a bug report
 * and a line in the panel.
 */
const VIEW_FILE = /^[a-zA-Z0-9._-]+\.html$/;

/** Enough for a set of overlays; not a site. */
const MAX_VIEWS = 8;

/**
 * A setting key.
 *
 * It becomes a property name in `out[field.key] = …` and a key in plugins.json.
 * The rule that earns its place is the leading letter: without it "__proto__"
 * is a legal key and that assignment writes *through* the object instead of
 * into it, so every plugin loaded afterwards inherits whatever was put there.
 *
 * camelCase is allowed on purpose. Plugin authors write JavaScript and would
 * spell it that way; forbidding it buys nothing and would be a rule people trip
 * over for no reason they can see.
 */
const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * Names that pass the pattern but should not be settings.
 *
 * None of these reaches the prototype the way "__proto__" does — they would be
 * ordinary own properties — but a plugin whose config has a `constructor` field
 * is going to confuse something downstream eventually, and the cost of saying
 * no here is one line.
 */
const RESERVED = new Set(['constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

/** A plugin may not declare more than this; a thousand fields is not a setting. */
const MAX_FIELDS = 40;
/** Beyond this a choice is a list, and a list wants a different control. */
const MAX_OPTIONS = 24;
/** Room for a sentence, not for an essay that pushes the layout apart. */
const MAX_LABEL = 80;
const MAX_HELP = 200;
/** The caller checks this before reading; a manifest is a small text file. */
const MAX_BYTES = 65536;

/**
 * Characters that change how text around them is rendered rather than adding
 * any of their own.
 *
 * A plugin's name and labels are drawn in the app's own window next to the
 * app's own words. A right-to-left override in a plugin name can visually
 * rewrite the sentence it sits in, which is a cheap way to make a card claim
 * something Overtone never said.
 */
const INVISIBLE =
  // C0 controls, DEL and C1, the bidi marks, the embedding overrides, the
  // isolates. Written as escapes on purpose: as literals this line is a row
  // of characters nobody can see, review or type back.
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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
  const hasSurface = json.surface === true;
  if (!hasMain && !hasSurface) return { problem: 'neither main nor surface' };
  if (hasMain && (json.main.includes('..') || /[\\/]/.test(json.main))) {
    return { problem: 'main must be a file name in the plugin folder' };
  }

  const views = parseViews(json, hasSurface);
  if (typeof views === 'string') return { problem: views };

  const settings = Array.isArray(json.settings) ? json.settings : [];
  if (settings.length > MAX_FIELDS) return { problem: `${settings.length} fields, max ${MAX_FIELDS}` };

  const keys = new Set();
  for (const field of settings) {
    const problem = checkField(field, keys);
    if (problem) return { problem };
  }

  // Checked in a second pass: a field may point at one declared after it.
  for (const field of settings) {
    if (!field.showIf) continue;
    const problem = checkShowIf(field, settings);
    if (problem) return { problem };
  }

  // A field may say which page it belongs to, so the window can put it under
  // that page's address instead of in one undifferentiated list. A name that
  // matches no view would simply never be shown, which is worse than refusing.
  for (const field of settings) {
    if (field.view === undefined) continue;
    if (typeof field.view !== 'string' || !views.some((view) => view.id === field.view)) {
      return { problem: `field "${field.key || field.type}" names view "${field.view}"` };
    }
  }

  return { manifest: { ...json, settings, views } };
}

/**
 * The pages this plugin offers, each of which gets its own address.
 *
 * A plugin that declares none still has one: index.html, under the plugin's own
 * name. That is what every existing plugin means, so saying it here keeps the
 * rest of the app from having to care whether `views` was written.
 *
 * @returns {Array|string} the views, or what is wrong with them
 */
function parseViews(json, hasSurface) {
  if (!hasSurface) return [];

  const fallback = [{ id: 'main', file: 'index.html', name: json.name }];
  if (json.views === undefined) return fallback;
  if (!Array.isArray(json.views)) return 'views must be a list';
  if (!json.views.length) return fallback;
  if (json.views.length > MAX_VIEWS) return `${json.views.length} views, max ${MAX_VIEWS}`;

  const seen = new Set();
  const out = [];

  for (const view of json.views) {
    if (!view || typeof view !== 'object') return 'a view is not an object';
    if (typeof view.id !== 'string' || !VIEW_ID.test(view.id)) return `view id "${view.id}"`;
    if (seen.has(view.id)) return `two views called "${view.id}"`;
    seen.add(view.id);

    if (typeof view.file !== 'string' || !VIEW_FILE.test(view.file) || view.file.includes('..')) {
      return `view "${view.id}" file "${view.file}" — one .html name in public/`;
    }
    if (!view.name || (typeof view.name !== 'object' && typeof view.name !== 'string')) {
      return `view "${view.id}" has no name`;
    }
    if (tooLong(view.help, MAX_HELP)) return `view "${view.id}" help is over ${MAX_HELP}`;

    out.push({ id: view.id, file: view.file, name: view.name, help: view.help });
  }

  return out;
}

/** @returns {string|null} what is wrong with one field, or null */
function checkField(field, keys) {
  if (!field || typeof field !== 'object') return 'a field is not an object';
  if (!Object.prototype.hasOwnProperty.call(TYPES, field.type)) return `type "${field.type}"`;

  if (tooLong(field.label, MAX_LABEL)) return `a ${field.type} label is over ${MAX_LABEL} characters`;
  if (tooLong(field.help, MAX_HELP)) return `a ${field.type} help text is over ${MAX_HELP} characters`;

  // A note displays and holds nothing, so it needs no key and no default.
  if (field.type === 'note') {
    return tooLong(field.text, MAX_HELP) ? `a note is over ${MAX_HELP} characters` : null;
  }

  if (typeof field.key !== 'string' || !KEY.test(field.key) || RESERVED.has(field.key)) {
    return `key "${field.key}" — must start with a letter, then letters, digits or _`;
  }
  if (keys.has(field.key)) return `two fields called "${field.key}"`;
  keys.add(field.key);

  if (!Object.prototype.hasOwnProperty.call(field, 'default')) {
    return `"${field.key}" has no default`;
  }

  // Bounds first, because the default is then checked against them. A number
  // without them is a text box that happens to hold digits, and nothing
  // downstream could clamp it.
  if (field.type === 'number' || field.type === 'range') {
    if (!Number.isFinite(field.min) || !Number.isFinite(field.max)) {
      return `"${field.key}" is a ${field.type} without min and max`;
    }
    if (field.min >= field.max) return `"${field.key}": min is not below max`;
  }

  if (field.type === 'choice') {
    if (!Array.isArray(field.options) || !field.options.length) {
      return `"${field.key}" is a choice without options`;
    }
    if (field.options.length > MAX_OPTIONS) {
      return `"${field.key}" has ${field.options.length} options, max ${MAX_OPTIONS}`;
    }
  }

  // The default is the permanent fallback: coerce() returns it whenever a
  // stored value is unusable. One that is itself invalid would be handed back
  // for ever, so it is checked against its own field rather than trusted.
  return checkDefault(field);
}

/** @returns {string|null} */
function checkDefault(field) {
  const value = field.default;
  const wanted = HOLDS[field.type];

  if (wanted === 'boolean' && typeof value !== 'boolean') {
    return `"${field.key}": default is not true or false`;
  }
  if (wanted === 'number') {
    if (!Number.isFinite(value)) return `"${field.key}": default is not a number`;
    if (value < field.min || value > field.max) return `"${field.key}": default is outside min and max`;
  }
  if (wanted === 'string') {
    if (typeof value !== 'string') return `"${field.key}": default is not text`;
    if (field.type === 'choice' && !optionValues(field).includes(value)) {
      return `"${field.key}": default is not one of the options`;
    }
  }
  return null;
}

/** @returns {string|null} */
function checkShowIf(field, settings) {
  const rule = field.showIf;
  if (!rule || typeof rule !== 'object' || typeof rule.key !== 'string') {
    return `"${field.key}": showIf needs a key`;
  }
  if (rule.key === field.key) return `"${field.key}": showIf points at itself`;

  const target = settings.find((other) => other.key === rule.key);
  if (!target) return `"${field.key}": showIf names "${rule.key}", which is not a field`;
  // One level only. Chained conditions are a rendering problem the window has
  // no shape for, and a cycle would hang it.
  if (target.showIf) return `"${field.key}": showIf points at a field that is itself conditional`;
  return null;
}

/** Option values, whether written bare or as { value, label }. */
function optionValues(field) {
  return (field.options || []).map((option) =>
    option && typeof option === 'object' ? option.value : option,
  );
}

function tooLong(value, max) {
  if (typeof value === 'string') return value.length > max;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((text) => typeof text === 'string' && text.length > max);
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
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value && typeof value === 'object') {
    text =
      (typeof value[locale] === 'string' && value[locale]) ||
      (typeof value.en === 'string' && value.en) ||
      Object.values(value).find((v) => typeof v === 'string') ||
      '';
  }
  // Drawn in the app's own window beside the app's own words, so anything that
  // rewrites the text around it comes out here.
  return text.replace(INVISIBLE, '');
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

    // Switched on the DECLARED type, never on `typeof fallback`. Reading the
    // type off the default makes the default the authority on its own
    // validity: a choice whose default is a number would take the number path
    // and skip the membership check entirely.
    switch (field.type) {
      case 'switch':
        out[field.key] = Boolean(raw);
        break;

      case 'number':
      case 'range': {
        let value = Number(raw);
        if (!Number.isFinite(value)) value = fallback;
        value = Math.min(field.max, Math.max(field.min, value));
        if (field.step === 1) value = Math.round(value);
        out[field.key] = value;
        break;
      }

      case 'choice': {
        const value = typeof raw === 'string' ? raw.trim() : '';
        out[field.key] = optionValues(field).includes(value) ? value : fallback;
        break;
      }

      default: {
        let value = typeof raw === 'string' ? raw.trim() : String(fallback ?? '');
        if (Number.isFinite(field.maxLength)) value = value.slice(0, field.maxLength);
        out[field.key] = value;
      }
    }
  }

  return out;
}

module.exports = {
  parseManifest,
  pick,
  defaults,
  coerce,
  optionValues,
  ENGINE,
  MAX_VIEWS,
  TYPES,
  ID,
  KEY,
  MAX_FIELDS,
  MAX_OPTIONS,
  MAX_LABEL,
  MAX_HELP,
  MAX_BYTES,
};
