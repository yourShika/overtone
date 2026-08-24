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
  constructor({ directory, logger = console }) {
    this.directory = directory;
    this.logger = logger;
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

module.exports = { LyricsLibrary, formatTimestamp, safeName, MANAGED_MARKER };
