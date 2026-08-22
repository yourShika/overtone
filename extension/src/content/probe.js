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
  /**
   * How long to let a navigation settle before reading the player.
   *
   * Long enough that YouTube's own handlers have run, short enough that a new
   * track still shows up promptly.
   */
  const SETTLE_MS = 250;
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

    if (!data.video_id) return browsing();

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

    // An unstarted or cued player has metadata but nothing to report yet —
    // which on YouTube usually means the person is simply looking around.
    if (state === -1 || state === 5) return browsing();

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
      loop: loopEnabled(video),
      fault: faultReport(video, state),
    };
  }

  /**
   * Whether the current track will repeat.
   *
   * On YouTube the right-click "Loop" option sets the media element's own flag,
   * which is exact. YouTube Music has its own repeat control instead, and its
   * markup has changed more than once, so several spellings are tried and a
   * miss simply means "not looping" rather than an error.
   */
  function loopEnabled(video) {
    if (video && video.loop) return true;
    if (!isMusic) return false;

    try {
      const bar = document.querySelector('ytmusic-player-bar');
      const mode = bar && bar.getAttribute('repeat-mode_');
      if (mode && mode !== 'NONE') return true;

      const button = document.querySelector('ytmusic-player-bar .repeat, ytmusic-player-bar [aria-label*="epeat"]');
      if (!button) return false;
      if (button.getAttribute('aria-pressed') === 'true') return true;
      // The label itself carries the state once repeat is on.
      const label = button.getAttribute('aria-label') || button.title || '';
      return /off/i.test(label) === false && /repeat/i.test(label) && button.hasAttribute('active');
    } catch {
      return false;
    }
  }

  /**
   * A YouTube tab with nothing playing.
   *
   * Reported rather than swallowed so the presence can say "watching YouTube"
   * while browsing. Only from a visible tab: a forgotten background tab would
   * otherwise claim the profile indefinitely.
   */
  function browsing() {
    if (document.visibilityState !== 'visible') return null;

    const path = location.pathname;
    let page = 'browsing';
    if (path === '/' || path === '') page = 'home';
    else if (path.startsWith('/results')) page = 'search';
    else if (path.startsWith('/feed/subscriptions')) page = 'subscriptions';
    else if (path.startsWith('/feed/history')) page = 'history';
    else if (path.startsWith('/playlist')) page = 'playlist';
    else if (path.startsWith('/@') || path.startsWith('/channel/') || path.startsWith('/c/')) page = 'channel';
    else if (path.startsWith('/shorts')) page = 'shorts';

    return {
      idle: true,
      source: isMusic ? 'ytmusic' : 'youtube',
      page,
      url: location.origin + location.pathname,
    };
  }

  /**
   * What the media element says when playback is broken.
   *
   * The reported fault — black picture, nothing plays, the timer flipping
   * between 0:00 and the full duration — is a media-pipeline failure, not a
   * scripting one, and the pipeline states it plainly if anyone asks. Reading
   * it at the moment it happens beats guessing afterwards:
   *
   *   error.code 4        the format cannot be played (codec or DRM)
   *   error.code 2        the segments failed to load (network or refused)
   *   networkState 3      no usable source at all
   *   readyState 0 or 1   metadata may exist, media data does not — which is
   *                       exactly what makes the timer jump about
   *
   * @returns {object|null} null while playback looks healthy
   */
  function faultReport(video, playerState) {
    if (!video) return null;

    const error = video.error || null;
    const starved = video.readyState < 2 && video.networkState === 3;
    // Claiming to play while holding no data is the state behind the symptom.
    const stalled = playerState === PLAYING && video.readyState < 2;

    if (!error && !starved && !stalled) return null;

    return {
      errorCode: error ? error.code : null,
      errorMessage: error && error.message ? String(error.message).slice(0, 200) : '',
      networkState: video.networkState,
      readyState: video.readyState,
      buffered: video.buffered ? video.buffered.length : 0,
      currentTime: Number(video.currentTime) || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      hasSource: Boolean(video.currentSrc),
      playerState,
    };
  }

  /** Last resort when the player API is unavailable (very early page load). */
  function domFallback() {
    const video = document.querySelector('video');
    if (!video || !video.src) return browsing();

    const videoId = videoIdFromLocation();
    if (!videoId) return browsing();

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

  let lastSerialised = null;

  function publish() {
    let payload = null;
    try {
      payload = snapshot();
    } catch {
      payload = null;
    }

    // Skip identical repeats. Over a day this is tens of thousands of messages
    // into the page's own context, and the overwhelming majority say nothing
    // new; the agent interpolates position between reports anyway.
    let serialised;
    try {
      serialised = JSON.stringify(payload);
    } catch {
      serialised = null;
    }
    if (serialised !== null && serialised === lastSerialised) return;
    lastSerialised = serialised;

    window.postMessage({ [CHANNEL]: true, snapshot: payload }, location.origin);
  }

  const timer = setInterval(publish, POLL_MS);

  let settleTimer = null;

  /**
   * Read the player *after* YouTube has finished what it was doing.
   *
   * This used to listen in the capture phase and call the player API straight
   * from inside YouTube's own event dispatch — so this script ran before
   * YouTube's handlers and reached into `movie_player` while it was still being
   * reconfigured, which `yt-player-updated` announces by definition. Deferring
   * out of the dispatch removes any chance of interleaving with that work, and
   * costs only a fraction of a second before a new track is picked up.
   *
   * Repeated events coalesce: a playlist advance fires several in a row.
   */
  function scheduleProbe() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(publish, SETTLE_MS);
  }

  // YouTube is a single-page app, so its own navigation event is what tells us
  // a new video started. Bubble phase, deliberately: YouTube goes first.
  for (const event of ['yt-navigate-finish', 'yt-player-updated']) {
    document.addEventListener(event, scheduleProbe);
  }

  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(timer);
      clearTimeout(settleTimer);
    },
    { once: true },
  );

  publish();
})();
