'use strict';

/**
 * What each plugin is set to, kept apart from the app's own settings.
 *
 * Not config.json, for a reason the app already proves the hard way: Config's
 * sanitise() drops any key it does not recognise, so a plugin's values written
 * there would vanish on the next save without a word. Keeping them here also
 * means a plugin cannot collide with an app setting, and removing a plugin
 * leaves one obvious place its leftovers sit.
 *
 * Values are stored as given and coerced against the schema on the way out, so
 * a plugin whose manifest changes — a field renamed, a bound tightened — finds
 * sane values rather than yesterday's shape.
 */

const fs = require('node:fs');
const path = require('node:path');

class PluginStore {
  /**
   * @param {string} file  %APPDATA%/Overtone/plugins.json
   * @param {object} [logger]
   */
  constructor(file, logger = console) {
    this.file = file;
    this.logger = logger;
    /** @type {Record<string, { enabled: boolean, values: object }>} */
    this.data = {};
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      // No file yet is the ordinary first run, not a problem worth reporting.
      this.data = {};
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      // Keep going with nothing rather than refusing to start. The file is
      // rewritten on the next change, so a corrupted one costs settings, not
      // the app — and the log says which.
      this.logger.warn?.(`plugins.json could not be read: ${err.message}`);
      this.data = {};
    }
  }

  /** Off unless someone turned it on. Nothing runs because it was installed. */
  isEnabled(id) {
    return this.entry(id).enabled === true;
  }

  /** Raw stored values; the caller coerces them against the current schema. */
  valuesFor(id) {
    const values = this.entry(id).values;
    return values && typeof values === 'object' ? values : {};
  }

  setEnabled(id, on) {
    this.entry(id).enabled = Boolean(on);
    this.save();
  }

  /**
   * Store one value.
   *
   * Deliberately not a whole-object write: the window sends one field at a
   * time, and merging here means two windows cannot clobber each other's
   * unrelated fields.
   */
  setValue(id, key, value) {
    this.entry(id).values[key] = value;
    this.save();
  }

  /** Everything about one plugin, created empty on first touch. */
  entry(id) {
    // hasOwnProperty, not `in`: a key like "constructor" would otherwise find
    // something on the prototype and be treated as an existing entry.
    if (!Object.prototype.hasOwnProperty.call(this.data, id)) {
      this.data[id] = { enabled: false, values: {} };
    }
    const entry = this.data[id];
    if (!entry.values || typeof entry.values !== 'object') entry.values = {};
    return entry;
  }

  /** Forget a plugin entirely, for when its folder is gone. */
  forget(id) {
    if (!Object.prototype.hasOwnProperty.call(this.data, id)) return;
    delete this.data[id];
    this.save();
  }

  /**
   * Write through a temporary file, the same way Config does.
   *
   * A half-written plugins.json is worse than none: it parses as broken on the
   * next start and every plugin looks freshly installed. Renaming over the top
   * is atomic on both filesystems this ships to.
   */
  save() {
    const temp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, this.file);
    } catch (err) {
      this.logger.warn?.(`plugins.json could not be written: ${err.message}`);
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* nothing more to do about it */
      }
    }
  }
}

module.exports = { PluginStore };
