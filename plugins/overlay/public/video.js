'use strict';

/**
 * The video overlay.
 *
 * Shows whatever is playing, muted, as a moving background — the thing to put
 * underneath a waiting screen or a pause card at whatever opacity suits.
 *
 * No script of YouTube's runs here. The player is started by its address and
 * then spoken to over postMessage — which is all YouTube's iframe API script
 * does, wrapped in a hundred kilobytes. So the page can ask where the player
 * is and tell it where to go, and `script-src 'self'` still stands over a page
 * served entirely from this machine.
 *
 * That channel is what keeps the picture on the beat. `start=` alone cannot:
 * it is chosen when the frame is built, and everything the player then spends
 * loading is lag nothing can see — the page would be comparing the player
 * against a model that assumed playback began the instant the element existed.
 * Now the player is asked, and nudged when it has fallen behind.
 *
 * Two consequences worth knowing, because neither can be worked around here:
 *
 *  - A video whose uploader disallowed embedding shows YouTube's own "not
 *    available" panel. Nothing on this side can read that — the frame is
 *    cross-origin — so the artwork source is a switch rather than a fallback.
 *  - The embedded player may show ads, exactly as it would on a web page.
 */

(() => {
  /**
   * Reach this page by name, not by number.
   *
   * YouTube's player refuses to run for a page whose origin is a bare loopback
   * IP — it answers with "error 153", the configuration error, and plays
   * nothing. Measured against the same video: the embed reports itself playable
   * for `http://localhost:PORT/` and does not for `http://127.0.0.1:PORT/`.
   *
   * Both names are this machine and the address is otherwise identical, token
   * and all, so moving there costs one navigation nobody sees. Done first,
   * before anything else runs, so the page does not build a player it is about
   * to throw away. `?loopback=ip` opts out for anyone who needs it — the
   * artwork source works either way.
   */
  if (location.hostname === '127.0.0.1' && new URLSearchParams(location.search).get('loopback') !== 'ip') {
    const there = new URL(location.href);
    there.hostname = 'localhost';
    location.replace(there.toString());
    return;
  }

  const body = document.body;
  const els = {
    frame: document.getElementById('frame'),
    art: document.getElementById('art'),
  };

  const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';

  /** How far out of step with the song the frame may drift before a reload. */
  const RESYNC_AFTER_S = 6;
  /**
   * How far out the player may be before it is worth a correction.
   *
   * A seek is a visible jump, so this is not zero — but it is far tighter than
   * it was, because both clocks run at the same speed: once they agree they
   * keep agreeing, and a correction only follows a buffer stall or a seek.
   */
  const NUDGE_AFTER_S = 0.35;
  /**
   * After a correction, how long before the landing is worth measuring.
   *
   * Short, because a seek that has not finished cannot be mistaken for one that
   * has: the player says it is buffering, and a reading taken then is thrown
   * away above. What this really buys is one settled reading before the next
   * correction, and waiting longer only left a bad landing standing.
   */
  const SETTLE_MS = 1200;
  /** A reading older than this is not a reading. */
  const STALE_MS = 1200;
  /** How much of each measurement is believed, against what is known already. */
  const LEARN = 0.6;
  /** Hold the last frame this long after the agent goes quiet, then fade. */
  const GONE_AFTER_MS = 20000;

  let state = null;
  let receivedAt = 0;
  /** What the frame currently holds, so it is only rebuilt when it must be. */
  let showing = { video: '', at: 0 };
  /**
   * Where the player says it is, and when it said so.
   *
   * Null until it has said anything, which is also the signal that the channel
   * below is working at all — without it the page falls back to guessing.
   */
  let reported = null;
  /** The player's own state, when it says: 1 playing, 2 paused, 3 buffering. */
  let playerState = null;
  /** When the last correction went out, and what it was aiming at. */
  let nudgedAt = 0;
  let nudgedTo = 0;
  /** Whether the landing of that correction has been measured yet. */
  let nudgeMeasured = true;

  /**
   * How long a player takes from being built to playing its first frame.
   *
   * Handed to the next one as a head start, so a slow load stops turning into
   * lag instead of being corrected afterwards. A guess to begin with, and only
   * until the first mount has been watched.
   */
  let warmup = remembered('warmup', 1.5, 0, 12);
  /**
   * How far past the target a seek has to aim to land on it.
   *
   * Zero to begin with — deliberately. The old code assumed a third of a second
   * and was wrong in a direction nobody could see, which is exactly the bias
   * this is here to remove rather than replace. Whatever it really costs is
   * measured from where the player lands.
   */
  let lead = remembered('lead', 0, -2, 2);
  /** Set once playback has actually begun, so the mount can be scored. */
  let moving = false;
  /** The manual offset, in seconds. Minus shows the video later. */
  let trim = 0;

  connect();
  setInterval(watch, 500);

  /*
   * A scene OBS is not drawing gets no player.
   *
   * A hidden page is throttled and the video stops, and a stopped player puts
   * its play icon over the middle — so switching to another scene and back
   * would bring the icon with it. Taking the frame down while hidden means
   * there is nothing to stop, and it saves the decode as well; coming back
   * rebuilds it at the right second, which it would have had to do anyway.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearFrame();
    else paint();
  });

  /**
   * Listen to the player.
   *
   * The embedded player answers postMessage, and YouTube's iframe API script is
   * only a wrapper around exactly this — so the readings come without loading a
   * line of anybody else's code, and `script-src 'self'` stands.
   *
   * Everything arriving here is another site's data, so it is checked before it
   * is believed: the right origin, the frame we built, and a number where a
   * number belongs.
   */
  window.addEventListener('message', (event) => {
    if (event.origin !== PLAYER_ORIGIN) return;

    const frame = els.frame.firstElementChild;
    if (!frame || event.source !== frame.contentWindow) return;

    let data = event.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }

    const info = data?.info;
    if (info && typeof info.playerState === 'number') playerState = info.playerState;

    const time = Number(info?.currentTime);
    if (!Number.isFinite(time) || time < 0) return;

    const previous = reported;
    reported = { at: time, when: performance.now() };

    /*
     * The moment the clock first advances is the moment playback began — which
     * is the one thing worth knowing about a mount, and not the same as the
     * first message: the player answers while it is still buffering.
     *
     * Where it is *then*, against where the song is *then*, is the whole score
     * for the head start it was given. Too big and the picture starts ahead of
     * the sound, which is the complaint this is answering.
     */
    if (!moving && previous && time > previous.at + 0.05) {
      moving = true;

      /*
       * How long it took, straight off the clock — not worked back from where
       * the player landed.
       *
       * Working it back was wrong, and wrong in a way that got worse each time:
       * `start=` takes whole seconds only, so every mount is up to half a
       * second out by rounding alone, and treating that as news about the load
       * had the estimate chasing noise. It fell 1.5 → 0.6 → 0.3 over three
       * loads of the same page on the same line. The stopwatch says what the
       * arithmetic could not.
       */
      const took = (performance.now() - showing.mountedAt) / 1000;
      warmup = clampNumber(warmup * (1 - LEARN) + took * LEARN, 0, 12);
      remember('warmup', warmup);

      // And one correction now, whatever the error. This is the moment somebody
      // notices — the picture appears — and the mount cannot have been better
      // than half a second because of that rounding. Waiting for the tolerance
      // to be exceeded would leave up to half a second standing for the whole
      // song.
      straighten();
    }
  });

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

    // Everything between the browser tab and this page — the reading, the
    // hops, the player's own start-up — lands here as one number somebody can
    // see the effect of immediately. Minus shows the video later.
    trim = number(value('videoSync', 0), -3, 3);

    // Grown past the box so the player's own title and subtitles fall outside.
    root.setProperty('--crop', String(number(value('videoCrop', 32), 0, 60) / 100));

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

    /*
     * A paused song shows the artwork, not a paused player.
     *
     * The embed draws a state icon over the middle of itself, and unlike the
     * title along the top that one cannot be cropped away — it sits dead
     * centre. So the answer is not to be in that state: while the song is
     * paused there is no player at all, and the artwork drifts in its place.
     * Which is also the better picture, a frozen frame being the one thing a
     * background should not be.
     */
    const still = body.dataset.source === 'art' || state.paused || document.hidden;
    body.dataset.showing = still ? 'art' : 'video';

    if (still) {
      clearFrame();
      return;
    }

    const at = position();

    // A different song is the one thing that always needs a new player.
    if (state.video !== showing.video) {
      mountFrame(state.video, at);
      return;
    }

    // Without readings there is nothing to nudge towards, so a big divergence
    // falls back to what this did before: build it again. `expected()` is only
    // a model, which is why it is not trusted while the player is talking.
    if (!reported && Math.abs(at - expected()) > RESYNC_AFTER_S) {
      mountFrame(state.video, at);
    }
  }

  /**
   * Where the picture should be, including the trim.
   *
   * The song's position as this page knows it, which is the agent's reading
   * carried on an anchor — plus whatever the slider says, because the last
   * stretch of the delay happens between the browser tab and here and cannot
   * be measured from inside this page. Somebody watching both at once can see
   * it in a second, so they are given the knob rather than a guess.
   */
  function target() {
    return position() + trim;
  }

  /** Where the player is, or null when its word is too old to use. */
  function playerAt() {
    if (!reported) return null;
    const age = performance.now() - reported.when;
    if (age > STALE_MS) return null;
    // Buffering freezes the player's clock while this one keeps running, so a
    // reading taken through a stall is not a reading.
    if (playerState === 3) return null;
    return reported.at + age / 1000;
  }

  /**
   * Hold the picture on the song.
   *
   * Two things happen here, and the order matters. First the landing of the
   * last correction is scored, because that is the only way to learn what a
   * seek really costs — asking for a point and seeing where it arrives. Then,
   * if the picture has drifted, another correction goes out aimed by what has
   * been learned.
   *
   * A correction is a seek rather than a rebuild: seeking keeps the picture,
   * where building the frame again costs another load — the very thing that
   * put it behind to begin with.
   */
  function sync() {
    const frame = els.frame.firstElementChild;
    if (!frame || !state || state.paused) return;

    const now = playerAt();
    if (now === null) return;

    const settled = performance.now() - nudgedAt >= SETTLE_MS;
    if (!settled) return;

    const error = now - target();

    // Score the last correction: it aimed at target + lead, so whatever it is
    // out by is what the lead was out by.
    if (!nudgeMeasured) {
      nudgeMeasured = true;
      lead = clampNumber(lead * (1 - LEARN) + (lead - error) * LEARN, -2, 2);
      remember('lead', lead);
    }

    if (Math.abs(error) < NUDGE_AFTER_S) return;
    straighten();
  }

  /** Aim the player at the target, by what the last landing taught. */
  function straighten() {
    const frame = els.frame.firstElementChild;
    if (!frame) return;

    const to = Math.max(0, target() + lead);
    if (!command(frame, 'seekTo', [to, true])) return;

    nudgedAt = performance.now();
    nudgedTo = to;
    nudgeMeasured = false;
  }

  /** Say something to the player. False when the frame has gone. */
  function command(frame, func, args) {
    try {
      frame.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }),
        PLAYER_ORIGIN,
      );
      return true;
    } catch {
      // A frame on its way out. The next pass will find it gone.
      return false;
    }
  }

  /** What the synchroniser knows, for anyone looking into the page. */
  function syncReport() {
    const now = playerAt();
    return {
      target: Number(target().toFixed(2)),
      player: now === null ? null : Number(now.toFixed(2)),
      error: now === null ? null : Number((now - target()).toFixed(2)),
      lead: Number(lead.toFixed(2)),
      warmup: Number(warmup.toFixed(2)),
      trim,
      playerState,
      lastAimedAt: nudgedTo ? Number(nudgedTo.toFixed(2)) : null,
    };
  }
  window.overtoneSync = syncReport;

  /**
   * Put the player in the page, pointed at this second of this song.
   *
   * Rebuilding the element rather than assigning to `src` is deliberate: an
   * iframe that has its src replaced adds an entry to the page's session
   * history, and a Browser Source left running for an evening accumulates one
   * per song.
   */
  function mountFrame(video, at) {
    const parameters = new URLSearchParams({
      // Not YouTube's script — just the postMessage channel it talks over, so
      // the player can be asked where it is and told where to go.
      enablejsapi: '1',
      origin: location.origin,
      // Always. A player that is not playing draws its own icon over the middle
      // of itself, and the paused song never reaches this function — it shows
      // the artwork instead.
      autoplay: '1',
      // Muted always. The sound is already coming from wherever the song is
      // actually playing, and two of them a second apart is unusable.
      mute: '1',
      controls: '0',
      disablekb: '1',
      fs: '0',
      rel: '0',
      modestbranding: '1',
      // No subtitles. The player brings its own along when the viewer's account
      // has them switched on, and burnt-in German captions over a background
      // that is meant to sit behind a waiting screen — beneath the lyric
      // overlay, quite possibly — is the opposite of what this is for.
      cc_load_policy: '0',
      playsinline: '1',
      iv_load_policy: '3',
      // Where the song will be once this player has finished loading, not
      // where it is now — everything the load takes is otherwise lag. Whole
      // seconds is all `start` accepts; the rest is the correction's job.
      start: String(Math.max(0, Math.round(at + warmup))),
    });

    const frame = document.createElement('iframe');
    frame.allow = 'autoplay; encrypted-media';
    /**
     * The origin, and only the origin.
     *
     * Sending nothing is the other half of error 153 — the player has to know
     * which page is embedding it. But the surface token lives in this page's
     * *path*, and the whole document is served under `Referrer-Policy:
     * no-referrer` to keep it out of anything that leaves this machine. So the
     * frame overrides that policy with the narrowest setting that still says
     * something: `http://localhost:PORT/`, no path, no token.
     */
    frame.referrerPolicy = 'origin';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = `https://www.youtube-nocookie.com/embed/${video}?${parameters}`;

    // A new player knows nothing yet, and the old one's readings would be
    // taken for its own.
    reported = null;
    playerState = null;
    moving = false;
    nudgedAt = 0;
    nudgeMeasured = true;

    frame.addEventListener('load', () => {
      // The handshake the API's own script sends. Without it the player talks
      // to nobody.
      try {
        frame.contentWindow?.postMessage(
          JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
          PLAYER_ORIGIN,
        );
      } catch {
        // A frame that went away between the event and here. The next mount
        // will try again; nothing here is worth an error for.
      }
    });

    els.frame.textContent = '';
    els.frame.appendChild(frame);
    showing = { video, at, mountedAt: performance.now() };
  }

  function clearFrame() {
    if (!els.frame.childElementCount) return;
    els.frame.textContent = '';
    showing = { video: '', at: 0 };
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
    return showing.at + (performance.now() - showing.mountedAt) / 1000;
  }

  /**
   * The agent went quiet mid-song: hold what is on screen for a moment, then
   * fade. A video from a song that ended minutes ago is worse than nothing.
   */
  function watch() {
    if (!state) return;
    sync();
    if (body.dataset.stale === 'yes' && performance.now() - receivedAt > GONE_AFTER_MS) {
      body.dataset.state = 'waiting';
      clearFrame();
    }
  }

  /** Bounds for numbers that are already numbers. */
  function clampNumber(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  /**
   * What this machine learned last time.
   *
   * How long a player takes to load is a property of the computer and the line
   * it is on, not of the session — so learning it again from scratch every time
   * OBS restarts means the first song of every evening starts in the wrong
   * place. That is the "only at the beginning" this is here to end.
   *
   * Storage is per address and stays in that browser, so two Browser Sources on
   * two machines each learn their own. Every access is guarded: a source with
   * site data switched off simply starts from the default, which is what the
   * default is for.
   */
  function remembered(name, fallback, low, high) {
    try {
      const raw = localStorage.getItem(`overtone.video.${name}`);
      // Tested as a string first, because Number(null) and Number('') are both
      // zero and neither is a reading — which had a fresh source start with a
      // load time of nought and put every first song half a second out.
      if (raw === null || raw.trim() === '') return fallback;

      const value = Number(raw);
      return Number.isFinite(value) ? clampNumber(value, low, high) : fallback;
    } catch {
      return fallback;
    }
  }

  function remember(name, value) {
    try {
      localStorage.setItem(`overtone.video.${name}`, String(value));
    } catch {
      // Private window, blocked site data, a quota. None of it is worth an
      // error: the next mount simply starts from what is in memory.
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
