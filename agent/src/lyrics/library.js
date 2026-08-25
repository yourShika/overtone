'use strict';

/**
 * Your own lyrics, kept as plain `.lrc` files on disk.
 *
 * Two jobs:
 *
 *  1. A place to put lyrics that no database has. Drop a file in, and Overtone
 *     uses it — from a transcription, a download, or typed by hand.
 *  2. Somewhere for LRCLIB hits to land, so a song you play again works without
 *     the network and keeps working if the database ever loses the entry.
 *
 * Files the user put there are never overwritten. A hand-corrected file
 * outranks anything fetched, which is the whole point of being able to correct
 * one; automatic writes carry a header comment and are the only ones replaced.
 *
 * Lookup is by video id, because it is exact. A second name based on artist and
 * title is also accepted, since that is what a human naturally types and it
 * carries across re-uploads of the same song.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { parseLrc } = require('./lrc');
const { t } = require('../i18n');

/** Marks a file this program wrote, and may therefore replace. */
const MANAGED_MARKER = '[re:overtone]';

class LyricsLibrary {
  /**
   * @param {{ directory: string, logger?: object }} options
   */
  /**
   * @param {{ directory: string, logger?: object, trash?: (file: string) => Promise<void> }} options
   * @param options.trash how to get rid of a file. Injected because the only
   *   recoverable delete on a desktop is the recycle bin, which lives in
   *   Electron's shell — and this class must stay testable without it.
   */
  constructor({ directory, logger = console, trash = null }) {
    this.directory = directory;
    this.logger = logger;
    this.trash = trash;
  }

  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  /**
   * Candidate filenames for a track, most specific first.
   * @returns {string[]}
   */
  candidates({ videoId, artist, track }) {
    const names = [];
    if (videoId) names.push(`${videoId}.lrc`);
    if (artist && track) names.push(`${safeName(`${artist} - ${track}`)}.lrc`);
    if (track) names.push(`${safeName(track)}.lrc`);
    return names;
  }

  /**
   * Read the first matching file.
   *
   * @returns {Promise<{ lines: Array, file: string, managed: boolean }|null>}
   */
  async find({ videoId, artist, track }) {
    for (const name of this.candidates({ videoId, artist, track })) {
      const file = path.join(this.directory, name);
      let raw;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        continue; // not there, try the next spelling
      }

      const lines = parseLrc(raw);
      if (!lines.length) {
        this.logger.warn?.(t('msg.lyricsBadFile', { file: name }));
        continue;
      }

      return { lines, file, managed: raw.includes(MANAGED_MARKER) };
    }
    return null;
  }

  /**
   * Store lyrics we fetched, so the next play needs no network.
   *
   * Refuses to touch a file the user wrote or edited: losing a hand-corrected
   * version to an automatic refetch would be the worst kind of data loss here,
   * because it is silent and only noticed much later.
   *
   * @returns {Promise<boolean>} whether anything was written
   */
  async store({ videoId, artist, track, lines, origin = 'lrclib' }) {
    if (!videoId || !Array.isArray(lines) || !lines.length) return false;

    const file = path.join(this.directory, `${videoId}.lrc`);

    try {
      const existing = await fs.readFile(file, 'utf8');
      if (!existing.includes(MANAGED_MARKER)) return false; // hand-made, leave it
    } catch {
      /* nothing there yet */
    }

    const header = [
      `[ti:${track || ''}]`,
      `[ar:${artist || ''}]`,
      `[by:Overtone (${origin})]`,
      MANAGED_MARKER,
      '',
    ];
    const body = lines.map((line) => `${formatTimestamp(line.time)}${line.text}`);

    try {
      await this.ensureDirectory();
      await fs.writeFile(file, `${header.concat(body).join('\n')}\n`, 'utf8');
      return true;
    } catch (err) {
      this.logger.warn?.(t('msg.lyricsNotSaved', { error: err.message }));
      return false;
    }
  }

  /**
   * Resolve a name that arrived from the settings window.
   *
   * preload.js enumerates every channel by hand so a compromised renderer
   * cannot reach the whole main process; a channel that takes a *name* would
   * hand back exactly that reach unless the name is confined here. One choke
   * point rather than a check per caller.
   *
   * @returns {string|null}
   */
  resolve(name) {
    if (typeof name !== 'string' || !name.toLowerCase().endsWith('.lrc')) return null;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
    const file = path.resolve(this.directory, name);
    if (path.dirname(file) !== path.resolve(this.directory)) return null;
    return file;
  }

  /**
   * Everything on disk, newest first.
   *
   * Deliberately without the text: a folder of a few hundred files would push
   * megabytes across IPC for a list nobody has opened a line of yet. The header
   * tags carry what a person recognises, and the marker decides whether the
   * entry may be replaced at all.
   *
   * @returns {Promise<Array<{name:string,title:string,artist:string,managed:boolean,lines:number,modified:number}>>}
   */
  async list() {
    let names;
    try {
      names = (await fs.readdir(this.directory)).filter((f) => f.toLowerCase().endsWith('.lrc'));
    } catch {
      return [];
    }

    const entries = [];
    for (const name of names) {
      const entry = await this.read(name);
      if (!entry) continue; // vanished between listing and reading
      let modified = 0;
      try {
        modified = (await fs.stat(path.join(this.directory, name))).mtimeMs;
      } catch {
        /* gone again */
      }
      entries.push({
        name: entry.name,
        title: entry.title,
        artist: entry.artist,
        managed: entry.managed,
        lines: parseLrc(entry.text).length,
        modified,
      });
    }

    // Newest first: the file that just arrived, or that you just corrected, is
    // the one you opened this list to find.
    entries.sort((a, b) => b.modified - a.modified);
    return entries;
  }

  /**
   * One file, raw, for showing and for editing.
   * @returns {Promise<{name:string,text:string,managed:boolean,title:string,artist:string}|null>}
   */
  async read(name) {
    const file = this.resolve(name);
    if (!file) return null;
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
    return {
      name,
      text,
      managed: text.includes(MANAGED_MARKER),
      title: tag(text, 'ti') || name.replace(/\.lrc$/i, ''),
      artist: tag(text, 'ar'),
    };
  }

  /**
   * Save an edited file.
   *
   * Drops the marker on purpose. Once a person has typed in this text it is
   * theirs, and store() must never replace it with a fetched version again —
   * keeping the marker would hand a later refetch permission to undo the very
   * correction that was just made. That is a one-way door, and the window says
   * so before the button is pressed.
   *
   * @returns {Promise<boolean>} whether anything was written
   */
  async write(name, text) {
    const file = this.resolve(name);
    if (!file || typeof text !== 'string') return false;
    // A file with no cue is one find() would skip and warn about anyway, so
    // refusing here turns a silent dud into an answer the window can give.
    if (!parseLrc(text).length) return false;

    const body = text
      .split(/\r?\n/)
      .filter((line) => !line.includes(MANAGED_MARKER))
      .join('\n');

    try {
      await this.ensureDirectory();
      await fs.writeFile(file, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
      return true;
    } catch (err) {
      this.logger.warn?.(t('msg.lyricsNotSaved', { error: err.message }));
      return false;
    }
  }

  /**
   * Delete one file.
   *
   * `force` is required for anything this program did not write, because that
   * file is the only copy of a correction that exists anywhere — no database
   * can hand it back and no cache holds it. Given a `trash` hook the delete is
   * recoverable; without one it is not, which is why the hook is not optional
   * in the app.
   *
   * @returns {Promise<'deleted'|'protected'|'missing'>}
   */
  async remove(name, { force = false } = {}) {
    const file = this.resolve(name);
    if (!file) return 'missing';

    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return 'missing';
    }
    if (!raw.includes(MANAGED_MARKER) && !force) return 'protected';

    try {
      if (this.trash) await this.trash(file);
      else await fs.rm(file, { force: true });
      return 'deleted';
    } catch (err) {
      this.logger.warn?.(t('msg.libraryDeleteFailed', { error: err.message }));
      return 'missing';
    }
  }

  /** @returns {Promise<{ total: number, managed: number }>} */
  async stats() {
    try {
      const files = (await fs.readdir(this.directory)).filter((f) => f.endsWith('.lrc'));
      let managed = 0;
      for (const name of files) {
        try {
          const raw = await fs.readFile(path.join(this.directory, name), 'utf8');
          if (raw.includes(MANAGED_MARKER)) managed += 1;
        } catch {
          /* vanished between listing and reading */
        }
      }
      return { total: files.length, managed };
    } catch {
      return { total: 0, managed: 0 };
    }
  }
}

/** `[mm:ss.xx]` — the form every LRC player understands. */
function formatTimestamp(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `[${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}]`;
}

/** Strip what Windows rejects in a filename, keeping it recognisable. */
function safeName(input) {
  return String(input)
    .replace(/[<>:\"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** One `[xx:value]` header tag, e.g. `[ti:Song]`. Absent reads as empty. */
function tag(raw, name) {
  const match = new RegExp(`^\\[${name}:(.*)\\]\\s*$`, 'im').exec(raw);
  return match ? match[1].trim() : '';
}

module.exports = { LyricsLibrary, formatTimestamp, safeName, tag, MANAGED_MARKER };
