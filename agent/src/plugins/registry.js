'use strict';

/**
 * Finds plugins on disk and turns each folder into something the window can
 * draw, whether or not it is any good.
 *
 * A folder that cannot be read is not skipped. It appears in the list as broken
 * with the reason beside it, because a plugin silently missing from the panel
 * is the worst outcome here: the author changes something, it vanishes, and
 * nothing anywhere says why.
 *
 * One root, and only one: the folder in your app data. Nothing is installed by
 * being shipped. The overlay that comes with Overtone is a template sitting
 * beside the program until somebody copies it in — after which it is theirs, it
 * can be edited, and an update will not put it back.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseManifest, pick, defaults, coerce, MAX_BYTES } = require('./manifest');

/** A folder name that could mean something other than a folder name. */
const UNSAFE = /[\\/\0]|^\.+$/;

class PluginRegistry {
  /**
   * @param {object} options
   * @param {string} options.userDir  %APPDATA%/Overtone/plugins
   * @param {object} options.store    PluginStore, for enabled state and values
   * @param {object} [options.logger]
   */
  constructor({ userDir, store, logger = console }) {
    this.userDir = userDir;
    this.store = store;
    this.logger = logger;
    /** @type {Map<string, object>} id -> { id, dir, manifest, problem } */
    this.plugins = new Map();
  }

  /** Make sure the folder exists, so the window can offer to open it. */
  async ensureUserDir() {
    await fs.mkdir(this.userDir, { recursive: true }).catch(() => {});
  }

  /**
   * Read the folder from scratch.
   *
   * Called on start and whenever someone presses Reload — never on a timer. A
   * plugin folder does not change by itself, and re-reading every file once a
   * second to notice that it did not would be absurd.
   */
  async scan() {
    this.plugins = new Map();
    await this.ensureUserDir();

    for (const name of await folders(this.userDir)) {
      this.plugins.set(name, await read(path.join(this.userDir, name), name));
    }

    return this.plugins;
  }

  /**
   * Everything the window needs, in the language it is drawn in.
   *
   * Values come back merged with the schema's defaults, so the renderer never
   * has to reason about a setting that has not been touched yet.
   */
  describe(locale) {
    const out = [];

    for (const entry of this.plugins.values()) {
      const { id, problem, manifest } = entry;

      if (problem || !manifest) {
        out.push({ id, problem: problem || 'unreadable', name: id, settings: [], values: {} });
        continue;
      }

      out.push({
        id,
        problem: null,
        name: pick(manifest.name, locale) || id,
        description: pick(manifest.description, locale),
        author: pick(manifest.author, locale),
        version: typeof manifest.version === 'string' ? manifest.version.slice(0, 20) : '',
        surface: manifest.surface === true,
        enabled: this.store.isEnabled(id),
        settings: describeFields(manifest.settings, locale),
        values: coerce(manifest.settings, this.store.valuesFor(id)),
      });
    }

    // By name, so the list does not reorder itself when a folder is added.
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Whether a folder of this name is already there, broken or not. */
  has(id) {
    return this.plugins.has(id);
  }

  /** The manifest for one plugin, or null if it is broken or unknown. */
  manifestFor(id) {
    return this.plugins.get(id)?.manifest || null;
  }

  /** Where a plugin's files live, or null. */
  dirFor(id) {
    return this.plugins.get(id)?.dir || null;
  }

  /** Enabled plugins that serve a page, which is what the server needs. */
  surfaces() {
    return this.describe('en').filter((p) => p.surface && p.enabled && !p.problem);
  }
}

/** Field descriptions with every author string already resolved. */
function describeFields(schema, locale) {
  return (schema || []).map((field) => ({
    type: field.type,
    key: field.key,
    label: pick(field.label, locale),
    help: pick(field.help, locale),
    text: pick(field.text, locale),
    min: field.min,
    max: field.max,
    step: field.step,
    showIf: field.showIf || null,
    options: (field.options || []).map((option) =>
      option && typeof option === 'object'
        ? { value: option.value, label: pick(option.label, locale) || String(option.value) }
        : { value: option, label: String(option) },
    ),
  }));
}

/** Subdirectories of `dir`, or nothing at all if it is not there. */
async function folders(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !UNSAFE.test(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

/** One folder, read into either a manifest or a reason it could not be. */
async function read(dir, id) {
  const file = path.join(dir, 'plugin.json');

  let size;
  try {
    // Checked before reading: a manifest is a small text file, and there is no
    // reason to pull a gigabyte into memory to find out it is not one.
    ({ size } = await fs.stat(file));
  } catch {
    return { id, dir, manifest: null, problem: 'no plugin.json' };
  }
  if (size > MAX_BYTES) {
    return { id, dir, manifest: null, problem: `plugin.json is ${size} bytes, max ${MAX_BYTES}` };
  }

  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    return { id, dir, manifest: null, problem: err.message };
  }

  const result = parseManifest(raw, { id });
  if (result.problem) return { id, dir, manifest: null, problem: result.problem };

  return { id, dir, manifest: result.manifest, problem: null };
}

module.exports = { PluginRegistry, describeFields, defaults, UNSAFE };
