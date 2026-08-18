'use strict';

/**
 * Player probe — runs in the page's MAIN world.
 *
 * Content scripts live in an isolated world and cannot call page JavaScript, so
 * this file is injected into the page itself. That buys us YouTube's own player
 * API (`getVideoData`, `getCurrentTime`, `getPlayerState`), which is far more
 * reliable than scraping the DOM: it survives layout redesigns, reports the
 * canonical video id even on Shorts and playlists, and knows about live streams.
 *
 * DOM scraping remains as a fallback for the rare moments the player object is
 * not exposed yet.
 *
 * Communication is one-way via window.postMessage; the isolated-world script
 * (bridge.js) picks it up and forwards it to the service worker.
 */

(() => {
  const CHANNEL = '__overtone__';
  const POLL_MS = 1000;

  const isMusic = location.hostname === 'music.youtube.com';

  /** YouTube player states (YT.PlayerState). */
  const PLAYING = 1;
  const BUFFERING = 3;

  function getPlayer() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    return player && typeof player.getVideoData === 'function' ? player : null;
  }

  function snapshot() {
    const player = getPlayer();
    if (!player) return domFallback();

    let data;
    try {
      data = player.getVideoData() || {};
    } catch {
      return domFallback();
    }

    if (!data.video_id) return null;

    let position = 0;
    let duration = 0;
    let state = -1;
    try {
      position = player.getCurrentTime() || 0;
      duration = player.getDuration() || 0;
      state = player.getPlayerState();
    } catch {
      /* player mid-teardown */
    }

    // An unstarted or cued player has metadata but nothing to report yet.
    if (state === -1 || state === 5) return null;

    const video = document.querySelector('video');
    // `isLive` is not always set; a live stream also reports duration 0 while
    // the seekable range keeps growing.
    const live = Boolean(data.isLive || data.isLiveContent) || (!duration && position > 0);

    return {
      source: isMusic ? 'ytmusic' : 'youtube',
      videoId: data.video_id,
      title: cleanTitle(data.title),
      artist: isMusic ? data.author || musicArtist() : '',
      album: isMusic ? musicAlbum() : '',
      channel: data.author || '',
      channelUrl: channelUrl(),
      url: watchUrl(data.video_id),
      thumbnail: isMusic ? musicArtwork() : '',
      duration: live ? 0 : duration,
      position,
      playbackRate: video?.playbackRate || 1,
      paused: !(state === PLAYING || state === BUFFERING),
      live,
      caption: captionText(),
      captionTrack: captionTrack(player),
    };
  }

  /** Last resort when the player API is unavailable (very early page load). */
  function domFallback() {
    const video = document.querySelector('video');
    if (!video || !video.src) return null;

    const videoId = videoIdFromLocation();
    if (!videoId) return null;

    const title =
      document.querySelector('#title h1 yt-formatted-string, ytd-watch-metadata h1')?.textContent ||
      cleanTitle(document.title.replace(/\s*-\s*YouTube(?:\s+Music)?$/i, ''));

    const channel =
      document.querySelector('#owner #channel-name a, ytd-channel-name#channel-name a')?.textContent || '';

    return {
      source: isMusic ? 'ytmusic' : 'youtube',
      videoId,
      title: (title || '').trim(),
      artist: isMusic ? musicArtist() : '',
      album: isMusic ? musicAlbum() : '',
      channel: channel.trim(),
      channelUrl: channelUrl(),
      url: watchUrl(videoId),
      thumbnail: isMusic ? musicArtwork() : '',
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      position: video.currentTime || 0,
      playbackRate: video.playbackRate || 1,
      paused: video.paused,
      live: !Number.isFinite(video.duration),
      caption: captionText(),
      captionTrack: '',
    };
  }

  // --- captions -------------------------------------------------------------

  /**
   * The subtitle line YouTube is showing right now.
   *
   * For music videos the caption track is very often the actual lyrics, already
   * perfectly timed — better than anything a lyrics database can offer, and it
   * covers songs no database has. Auto-generated and auto-translated tracks
   * work the same way.
   *
   * Read from the rendered DOM rather than fetched as a track file: the
   * timedtext endpoint needs signed parameters that change without notice,
   * while what is on screen is exactly what we want and is already in sync.
   *
   * Caveat: this only sees captions the viewer has switched ON. With subtitles
   * off, YouTube renders nothing and there is nothing to read.
   */
  function captionText() {
    const container = document.querySelector('.ytp-caption-window-container');
    if (!container) return '';

    // Prefer visual lines so a two-line caption keeps its word order; fall back
    // to raw segments if YouTube changes the wrapper.
    const lines = container.querySelectorAll('.caption-visual-line');
    const nodes = lines.length ? lines : container.querySelectorAll('.ytp-caption-segment');

    return [...nodes]
      .map((node) => node.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  /** Language of the active caption track, e.g. "pl" or "en (auto)". */
  function captionTrack(player) {
    try {
      const track = player.getOption('captions', 'track');
      if (!track || !track.languageCode) return '';
      return track.kind === 'asr' ? `${track.languageCode} (auto)` : track.languageCode;
    } catch {
      // getOption throws when the captions module is not loaded — normal.
      return '';
    }
  }

  // --- YouTube Music specifics ---------------------------------------------

  function musicArtwork() {
    const img =
      document.querySelector('#song-image img') ||
      document.querySelector('ytmusic-player-bar img.image') ||
      document.querySelector('ytmusic-player-bar img');
    return img?.src || '';
  }

  /** The player bar byline reads "Artist • Album • Year". */
  function musicByline() {
    const byline = document.querySelector('ytmusic-player-bar .byline');
    return (byline?.textContent || '').split('•').map((part) => part.trim());
  }

  function musicArtist() {
    return musicByline()[0] || '';
  }

  function musicAlbum() {
    const parts = musicByline();
    // Skip anything that is just a year or a view count.
    return parts.slice(1).find((part) => part && !/^\d{4}$/.test(part) && !/aufrufe|views/i.test(part)) || '';
  }

  // --- helpers --------------------------------------------------------------

  function videoIdFromLocation() {
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('v');
    if (fromQuery) return fromQuery;

    const shorts = /\/shorts\/([\w-]{6,})/.exec(location.pathname);
    return shorts ? shorts[1] : '';
  }

  function watchUrl(videoId) {
    if (!videoId) return location.href;
    return isMusic
      ? `https://music.youtube.com/watch?v=${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;
  }

  function channelUrl() {
    const link = document.querySelector(
      '#owner #channel-name a, ytd-channel-name#channel-name a, ytd-video-owner-renderer a',
    );
    const href = link?.getAttribute('href') || '';
    if (!href) return '';
    return href.startsWith('http') ? href : `https://www.youtube.com${href}`;
  }

  function cleanTitle(title) {
    return String(title || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // --- pump -----------------------------------------------------------------

  function publish() {
    let payload = null;
    try {
      payload = snapshot();
    } catch {
      payload = null;
    }
    window.postMessage({ [CHANNEL]: true, snapshot: payload }, location.origin);
  }

  const timer = setInterval(publish, POLL_MS);

  // YouTube is a single-page app: react to its own navigation event so a new
  // video is picked up without waiting a full poll interval.
  for (const event of ['yt-navigate-finish', 'yt-player-updated']) {
    document.addEventListener(event, publish, true);
  }

  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });

  publish();
})();
