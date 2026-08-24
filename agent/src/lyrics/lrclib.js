'use strict';

/**
 * LRCLIB lyrics provider (https://lrclib.net).
 *
 * Chosen because it is free, needs no API key, serves time-synced LRC, and asks
 * only that clients identify themselves via User-Agent. We are a good citizen:
 * every lookup is cached in memory and on disk, and negative results are cached
 * too so a song without lyrics is not re-requested every four seconds.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { t } = require('../i18n');

const { parseLrc } = require('./lrc');

const API = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 8000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_MEMORY_ENTRIES = 200;

class LyricsProvider {
  /**
   * @param {{ cacheDir: string, userAgent: string, logger?: object }} options
   */
  constructor({ cacheDir, userAgent, logger = console }) {
    this.cacheDir = cacheDir;
    this.userAgent = userAgent;
    this.logger = logger;

    /** @type {Map<string, { lines: Array, plain: string|null, at: number }>} */
    this.memory = new Map();
    /** @type {Map<string, Promise>} in-flight lookups, keyed identically */
    this.inflight = new Map();
  }

  /**
   * @param {{ artist: string, track: string, album?: string, duration?: number }} query
   * @returns {Promise<{ lines: Array<{time:number,text:string}>, plain: string|null, synced: boolean }|null>}
   */
  async lookup(query) {
    const artist = (query.artist || '').trim();
    const track = (query.track || '').trim();
    if (!track) return null;

    const key = cacheKey(artist, track, query.duration);

    const cached = this.memory.get(key);
    if (cached) {
      if (cached.lines === null && Date.now() - cached.at > NEGATIVE_TTL_MS) {
        this.memory.delete(key);
      } else {
        return toResult(cached);
      }
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = this._resolve(key, { ...query, artist, track })
      .catch((err) => {
        this.logger.warn?.(`[lyrics] Abfrage fehlgeschlagen: ${err.message}`);
        return null;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, promise);
    return promise;
  }

  async _resolve(key, query) {
    const fromDisk = await this._readDisk(key);
    if (fromDisk) {
      this._remember(key, fromDisk);
      return toResult(fromDisk);
    }

    let record = await this._fetchExact(query);
    if (!record) record = await this._fetchSearch(query);

    const entry = record
      ? {
          lines: parseLrc(record.syncedLyrics || ''),
          plain: record.plainLyrics || null,
          at: Date.now(),
        }
      : { lines: null, plain: null, at: Date.now() };

    this._remember(key, entry);
    // Only persist hits; a miss may just mean the title parse was off, and we
    // do not want that frozen on disk.
    if (entry.lines) await this._writeDisk(key, entry);

    return toResult(entry);
  }

  /** Exact endpoint: matches on artist + track + duration (±2s server-side). */
  async _fetchExact(query) {
    if (!query.artist) return null;

    const params = new URLSearchParams({
      artist_name: query.artist,
      track_name: query.track,
    });
    if (query.album) params.set('album_name', query.album);
    if (Number.isFinite(query.duration) && query.duration > 0) {
      params.set('duration', String(Math.round(query.duration)));
    }

    const response = await this._request(`${API}/get?${params}`);
    if (!response || response.status === 404) return null;
    if (!response.ok) return null;
    return response.json();
  }

  /** Fallback: fuzzy search, then pick the best candidate ourselves. */
  async _fetchSearch(query) {
    const params = new URLSearchParams({ track_name: query.track });
    if (query.artist) params.set('artist_name', query.artist);

    const response = await this._request(`${API}/search?${params}`);
    if (!response || !response.ok) return null;

    const results = await response.json();
    if (!Array.isArray(results) || !results.length) return null;

    return pickBest(results, query);
  }

  async _request(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _remember(key, entry) {
    // Cheap LRU: Map preserves insertion order, so the oldest key is first.
    if (this.memory.size >= MAX_MEMORY_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      this.memory.delete(oldest);
    }
    this.memory.set(key, entry);
  }

  _diskPath(key) {
    return path.join(this.cacheDir, `${key}.json`);
  }

  async _readDisk(key) {
    try {
      const raw = await fs.readFile(this._diskPath(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.lines)) return null;
      return { lines: parsed.lines, plain: parsed.plain ?? null, at: parsed.at ?? Date.now() };
    } catch {
      return null;
    }
  }

  async _writeDisk(key, entry) {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this._diskPath(key), JSON.stringify(entry), 'utf8');
    } catch (err) {
      this.logger.warn?.(t('msg.cacheWriteFailed', { error: err.message }));
    }
  }

  async clearCache() {
    this.memory.clear();
    try {
      const files = await fs.readdir(this.cacheDir);
      await Promise.all(
        files
          .filter((file) => file.endsWith('.json'))
          .map((file) => fs.rm(path.join(this.cacheDir, file), { force: true })),
      );
    } catch {
      /* nothing cached yet */
    }
  }
}

/** Rank candidates by duration proximity first, then title similarity. */
function pickBest(results, query) {
  const wanted = Number(query.duration) || 0;

  const scored = results
    .filter((item) => item && (item.syncedLyrics || item.plainLyrics))
    .map((item) => {
      let score = 0;

      if (wanted > 0 && Number.isFinite(item.duration)) {
        const delta = Math.abs(item.duration - wanted);
        if (delta <= 2) score += 50;
        else if (delta <= 5) score += 30;
        else if (delta <= 15) score += 10;
        else score -= delta;
      }

      if (item.syncedLyrics) score += 40; // synced beats plain, always
      if (similar(item.trackName, query.track)) score += 20;
      if (query.artist && similar(item.artistName, query.artist)) score += 20;

      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.length ? scored[0].item : null;
}

function similar(a, b) {
  const normalise = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  const left = normalise(a);
  const right = normalise(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function toResult(entry) {
  if (!entry || entry.lines === null) return null;
  return {
    lines: entry.lines,
    plain: entry.plain,
    synced: entry.lines.length > 0,
  };
}

function cacheKey(artist, track, duration) {
  const base = `${artist}__${track}__${Math.round(Number(duration) || 0)}`;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
}

module.exports = { LyricsProvider };
