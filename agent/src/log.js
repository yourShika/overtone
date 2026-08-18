'use strict';

/**
 * Logger with a bounded ring buffer.
 *
 * The buffer feeds the settings window's live log pane, which is the only
 * practical way to debug a tray app that has no console. Also mirrors to a file
 * so a crash leaves evidence behind.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  /** @param {{ filePath?: string, level?: keyof LEVELS, onEntry?: Function }} [options] */
  constructor(options = {}) {
    this.filePath = options.filePath || null;
    this.level = LEVELS[options.level] ?? LEVELS.info;
    this.onEntry = options.onEntry ?? null;
    /** @type {Array<{ ts: number, level: string, message: string }>} */
    this.entries = [];
    /** Whether file logging is usable; false disables it for the session. */
    this._ready = false;
    /** Bytes in the current file, tracked to avoid a stat() per line. */
    this._written = 0;

    if (this.filePath) this._openFile();
  }

  debug(message) {
    this._write('debug', message);
  }
  info(message) {
    this._write('info', message);
  }
  warn(message) {
    this._write('warn', message);
  }
  error(message) {
    this._write('error', message instanceof Error ? message.stack || message.message : message);
  }

  /** Snapshot for the settings window. */
  history() {
    return this.entries.slice();
  }

  setLevel(level) {
    this.level = LEVELS[level] ?? this.level;
  }

  /** Nothing to flush — every line is already on disk. Kept for symmetry. */
  close() {
    this._ready = false;
  }

  _write(level, message) {
    if (LEVELS[level] < this.level) return;

    const entry = { ts: Date.now(), level, message: String(message) };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    const line = `${new Date(entry.ts).toISOString()} [${level.toUpperCase()}] ${entry.message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    this._append(line);
    this.onEntry?.(entry);
  }

  /**
   * Appended synchronously on purpose.
   *
   * A buffered write stream leaves the file empty (or stale by minutes) for as
   * long as the process runs — which defeats the entire point, since "open the
   * log folder" is the documented way to diagnose a tray app that has no
   * console. Volume is a handful of lines per minute, so the cost of a
   * synchronous append is irrelevant next to being able to trust the file.
   */
  _append(line) {
    if (!this._ready) return;
    try {
      fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
      this._written += line.length + 1;
      if (this._written > MAX_FILE_BYTES) this._rotate();
    } catch {
      // Disk full, permissions, file locked — logging must never take the app
      // down with it. Stop trying and carry on.
      this._ready = false;
    }
  }

  _openFile() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this._written = statSize(this.filePath);
      this._ready = true;
      if (this._written > MAX_FILE_BYTES) this._rotate();
    } catch {
      this._ready = false;
    }
  }

  /** Naive rotation: one generation is plenty for a desktop helper. */
  _rotate() {
    try {
      fs.rmSync(`${this.filePath}.1`, { force: true });
      fs.renameSync(this.filePath, `${this.filePath}.1`);
      this._written = 0;
    } catch {
      /* keep appending to the current file rather than losing the log */
    }
  }
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0; // no log yet
  }
}

module.exports = { Logger, LEVELS };
