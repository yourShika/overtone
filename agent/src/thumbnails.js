'use strict';

/**
 * Artwork resolution.
 *
 * YouTube generates several thumbnail sizes per video, but `maxresdefault` only
 * exists when the uploader supplied a high-res source — for everything else it
 * 404s. Discord renders a broken asset as an empty grey box, so we HEAD-probe
 * the good ones and remember the winner per video.
 *
 * `hqdefault` is guaranteed to exist for every video and is the safety net.
 */

const PROBE_TIMEOUT_MS = 4000;
const MAX_CACHE = 300;

const QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault'];

class ThumbnailResolver {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    /** @type {Map<string, string>} videoId -> resolved url */
    this.cache = new Map();
    /** @type {Map<string, Promise<string>>} */
    this.inflight = new Map();
  }

  /**
   * @param {object} state playback snapshot
   * @param {boolean} highRes whether to probe beyond the guaranteed size
   * @returns {Promise<string|null>}
   */
  async resolve(state, highRes = true) {
    if (!state) return null;

    // YouTube Music hands us Google-hosted cover art with a size suffix we can
    // simply rewrite — no probing needed, it is always available.
    if (state.source === 'ytmusic' && state.thumbnail) {
      return upscaleGoogleArt(state.thumbnail);
    }

    if (!state.videoId) return state.thumbnail || null;

    const cached = this.cache.get(state.videoId);
    if (cached) return cached;

    if (!highRes) return youtubeThumb(state.videoId, 'hqdefault');

    if (this.inflight.has(state.videoId)) return this.inflight.get(state.videoId);

    const promise = this._probe(state.videoId)
      .catch(() => youtubeThumb(state.videoId, 'hqdefault'))
      .finally(() => this.inflight.delete(state.videoId));

    this.inflight.set(state.videoId, promise);
    return promise;
  }

  async _probe(videoId) {
    for (const quality of QUALITIES) {
      const url = youtubeThumb(videoId, quality);

      // hqdefault is guaranteed; skip the round-trip and take it.
      if (quality === 'hqdefault') {
        this._remember(videoId, url);
        return url;
      }

      if (await exists(url)) {
        this._remember(videoId, url);
        return url;
      }
    }

    const fallback = youtubeThumb(videoId, 'hqdefault');
    this._remember(videoId, fallback);
    return fallback;
  }

  _remember(videoId, url) {
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(videoId, url);
  }
}

async function exists(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    // YouTube answers a missing maxres with a 404, but some edges return a
    // 120x90 placeholder with 200 — the tiny content-length gives it away.
    if (!response.ok) return false;
    const length = Number(response.headers.get('content-length') || 0);
    return length === 0 || length > 2500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function youtubeThumb(videoId, quality) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${quality}.jpg`;
}

/** Rewrite `=w60-h60-l90-rj` style size hints to something Discord-worthy. */
function upscaleGoogleArt(url) {
  if (typeof url !== 'string') return null;
  if (!/googleusercontent\.com|ggpht\.com|ytimg\.com/.test(url)) return url;
  return url.replace(/=w\d+-h\d+/, '=w544-h544');
}

module.exports = { ThumbnailResolver, upscaleGoogleArt, youtubeThumb };
