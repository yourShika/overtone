'use strict';

/**
 * The video overlay.
 *
 * Shows whatever is playing, muted, as a moving background — the thing to put
 * underneath a waiting screen or a pause card at whatever opacity suits.
 *
 * The embed is driven by its address rather than by YouTube's JavaScript API.
 * That is a deliberate trade: the API would allow seeking without a reload, and
 * it would mean loading a third party's script into a page that is otherwise
 * served entirely from this machine under `script-src 'self'`. A reload on a
 * track change costs a second; the other costs the guarantee.
 *
 * Two consequences worth knowing, because neither can be worked around here:
 *
 *  - A video whose uploader disallowed embedding shows YouTube's own "not
 *    available" panel. Nothing on this side can read that — the frame is
 *    cross-origin — so the artwork source is a switch rather than a fallback.
 *  - The embedded player may show ads, exactly as it would on a web page.
 */

(() => {
  const body = document.body;
  const els = {
    frame: document.getElementById('frame'),
    art: document.getElementById('art'),
  };

  /** How far out of step with the song the frame may drift before a reload. */
  const RESYNC_AFTER_S = 6;
  /** Hold the last frame this long after the agent goes quiet, then fade. */
  const GONE_AFTER_MS = 20000;

  let state = null;
  let receivedAt = 0;
  /** What the frame currently holds, so it is only rebuilt when it must be. */
  let showing = { video: '', at: 0, paused: null };

  connect();
  setInterval(watch, 1000);

  function connect() {
    const feed = new EventSource('feed');

    feed.addEventListener('message', (event) => {
      let next = null;
      try {
        next = JSON.parse(event.data);
      } catch {
        return;
      }
      receive(next);
    });

    feed.addEventListener('error', () => {
      if (state && state.playing) body.dataset.stale = 'yes';
    });
  }

  function receive(next) {
    applySettings(next.settings);
    state = next;
    receivedAt = performance.now();
    delete body.dataset.stale;
    paint();
  }

  /**
   * Everything the panel sets, written onto the root as custom properties.
   *
   * Cheap and idempotent, so it simply runs on every message rather than
   * working out whether a slider moved.
   */
  function applySettings(settings) {
    const s = settings || {};
    const url = new URLSearchParams(location.search);
    // A source that wants to differ from the others says so in its own address,
    // and that wins — which is how two Browser Sources show the same song with
    // different effects.
    const value = (key, fallback) => (url.has(key) ? url.get(key) : (s[key] ?? fallback));

    const source = value('videoSource', 'video');
    body.dataset.source = source === 'art' ? 'art' : 'video';
    body.dataset.fit = value('videoFit', 'cover') === 'contain' ? 'contain' : 'cover';
    body.dataset.drift = String(value('videoDrift', true)) !== 'false' ? 'on' : 'off';

    const root = document.documentElement.style;
    root.setProperty('--blur', `${number(value('videoBlur', 0), 0, 40)}px`);
    root.setProperty('--saturate', String(number(value('videoSaturate', 100), 0, 300) / 100));
    root.setProperty('--brightness', String(number(value('videoBrightness', 100), 10, 200) / 100));
    root.setProperty('--contrast', String(number(value('videoContrast', 100), 10, 200) / 100));
    root.setProperty('--grey', String(number(value('videoGrey', 0), 0, 100) / 100));
    root.setProperty('--vignette', String(number(value('videoVignette', 0), 0, 100) / 100));

    // Enough to hide the edge the blur samples from, plus whatever was asked
    // for. Without the first part a blurred background has soft grey borders.
    const zoom = 1 + number(value('videoZoom', 0), 0, 60) / 100;
    root.setProperty('--zoom', String(zoom + number(value('videoBlur', 0), 0, 40) / 220));

    root.setProperty('--tint', colour(value('videoTint', '#000000')));
    root.setProperty('--tint-strength', String(number(value('videoTintStrength', 0), 0, 100) / 100));
    root.setProperty('--fade', `${number(value('videoFade', 700), 0, 3000)}ms`);
  }

  function paint() {
    if (!state || !state.playing || state.privacy || !state.video) {
      body.dataset.state = 'waiting';
      clearFrame();
      return;
    }

    body.dataset.state = 'playing';
    els.art.style.backgroundImage = state.cover ? `url("${cssUrl(state.cover)}")` : '';

    if (body.dataset.source === 'art') {
      clearFrame();
      return;
    }

    const at = position();
    const drifted = Math.abs(at - expected()) > RESYNC_AFTER_S;

    // Rebuilt only when it would show the wrong thing: a different song, a
    // pause that the frame does not know about, or a seek it cannot follow.
    if (state.video !== showing.video || state.paused !== showing.paused || drifted) {
      mountFrame(state.video, at, state.paused);
    }
  }

  /**
   * Put the player in the page, pointed at this second of this song.
   *
   * Rebuilding the element rather than assigning to `src` is deliberate: an
   * iframe that has its src replaced adds an entry to the page's session
   * history, and a Browser Source left running for an evening accumulates one
   * per song.
   */
  function mountFrame(video, at, paused) {
    const parameters = new URLSearchParams({
      autoplay: paused ? '0' : '1',
      // Muted always. The sound is already coming from wherever the song is
      // actually playing, and two of them a second apart is unusable.
      mute: '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      rel: '0',
      modestbranding: '1',
      playsinline: '1',
      iv_load_policy: '3',
      start: String(Math.max(0, Math.floor(at))),
    });

    const frame = document.createElement('iframe');
    frame.allow = 'autoplay; encrypted-media';
    frame.referrerPolicy = 'no-referrer';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = `https://www.youtube-nocookie.com/embed/${video}?${parameters}`;

    els.frame.textContent = '';
    els.frame.appendChild(frame);
    showing = { video, at, paused, mountedAt: performance.now() };
  }

  function clearFrame() {
    if (!els.frame.childElementCount) return;
    els.frame.textContent = '';
    showing = { video: '', at: 0, paused: null };
  }

  /** Where the song is now, from the anchor the agent stamped. */
  function position() {
    if (!state) return 0;
    if (state.paused) return state.position || 0;
    return (state.position || 0) + (performance.now() - receivedAt) / 1000;
  }

  /** Where the frame should have reached, if it has been playing since it was built. */
  function expected() {
    if (!showing.mountedAt) return position();
    if (showing.paused) return showing.at;
    return showing.at + (performance.now() - showing.mountedAt) / 1000;
  }

  /**
   * The agent went quiet mid-song: hold what is on screen for a moment, then
   * fade. A video from a song that ended minutes ago is worse than nothing.
   */
  function watch() {
    if (!state) return;
    if (body.dataset.stale === 'yes' && performance.now() - receivedAt > GONE_AFTER_MS) {
      body.dataset.state = 'waiting';
      clearFrame();
    }
  }

  function number(value, low, high) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return low;
    return Math.min(high, Math.max(low, parsed));
  }

  /** Only a plain hex colour reaches a stylesheet. */
  function colour(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? String(value) : 'transparent';
  }

  /** The artwork host is already fixed by the feed; this closes the quoting. */
  function cssUrl(value) {
    return String(value).replace(/["\\\n]/g, '');
  }
})();
