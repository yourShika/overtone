'use strict';

/**
 * The overlay page, as OBS runs it.
 *
 * Two clocks, and the split is the whole design. The agent sends a message only
 * when something actually changes and stamps it with where the song was at that
 * moment; this page runs its own clock from that anchor at animation-frame
 * rate. So a progress bar moves smoothly and a lyric lands on the beat while
 * the connection stays quiet for minutes at a time.
 *
 * Settings arrive in two layers. The panel's values travel with the song, so a
 * slider moved in Overtone reaches a Browser Source that is already open and
 * the address is pasted once and never again. Anything named in the address
 * itself wins over that, which is how one feed drives a card on one scene and
 * the lyrics alone on another.
 *
 * Everything from the feed is written with textContent. It is a song title
 * somebody else chose, arriving over a socket, and this page has no business
 * treating it as anything but text.
 */

(() => {
  const $ = (id) => document.getElementById(id);

  const body = document.body;
  const els = {
    wrap: $('wrap'),
    cover: $('cover'),
    title: $('title'),
    artist: $('artist'),
    elapsed: $('elapsed'),
    total: $('total'),
    fill: $('fill'),
    lyrics: $('lyrics'),
    idle: $('idle'),
  };

  /**
   * What a query string may ask for.
   *
   * Read from fixed lists rather than trusted: this is a URL anybody can edit,
   * and every value below ends up in a data attribute the stylesheet keys off.
   */
  const ALLOWED = {
    style: ['card', 'bar', 'lyrics', 'ticker'],
    background: ['none', 'glow', 'soft', 'solid'],
    font: ['sans', 'round', 'serif', 'mono', 'condensed'],
    lyricStyle: ['spotify', 'fade', 'slideUp', 'slideLeft', 'slideRight', 'plain'],
    align: ['left', 'center', 'right'],
    anchor: ['top', 'middle', 'bottom'],
  };

  /** How long a silent agent may be gone before the overlay fades. */
  const GONE_AFTER_MS = 10_000;
  /** Long enough to read as a change of subject, short enough not to miss a line. */
  const SWAP_MS = 260;

  let state = null;
  let receivedAt = 0;
  /** Walks forward through the cue list; never searches backwards. */
  let cueIndex = 0;
  let lastRenderedLine = -1;
  /** Cue text currently on screen, so only genuinely new lines animate in. */
  let onScreen = [];
  let swapTimer = null;

  start();

  function start() {
    applySettings(null);
    connect();
    requestAnimationFrame(tick);
    setInterval(advance, 1000);
    // Coming back into view: repaint at once rather than waiting for a frame.
    document.addEventListener('visibilitychange', advance);
  }

  /**
   * Apply the settings, from the panel and then from the address.
   *
   * Two layers, and the order is the point. The panel's values arrive with the
   * song, so moving a slider reaches a Browser Source that is already open and
   * the address never has to be pasted again. Anything named in the address
   * wins, which is how a second source shows something else entirely from the
   * same feed.
   *
   * Both layers are read from fixed lists rather than trusted. The address is a
   * URL anybody can edit; the panel's values arrive over a socket. Neither is
   * ours until it has been checked.
   */
  function applySettings(fromPanel) {
    const params = new URLSearchParams(location.search);
    const panel = fromPanel && typeof fromPanel === 'object' ? fromPanel : {};

    /** The address, then the panel, then nothing. */
    const pick = (key) => (params.has(key) ? params.get(key) : panel[key]);
    const on = (key) => {
      const value = pick(key);
      return value === undefined || (value !== 'false' && value !== false);
    };

    for (const [key, allowed] of Object.entries(ALLOWED)) {
      const value = pick(key);
      if (allowed.includes(value)) body.dataset[attr(key)] = value;
    }

    const scale = Number(pick('scale'));
    if (Number.isFinite(scale) && scale >= 60 && scale <= 200) {
      document.documentElement.style.setProperty('--scale', String(scale / 100));
    }

    // #rrggbb only. A colour goes straight into a custom property, and a custom
    // property is somewhere CSS will accept far more than a colour.
    const accent = pick('accent');
    if (typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent)) {
      document.documentElement.style.setProperty('--accent', accent);
    }

    // Absent means on: every one of these defaults to true in the manifest.
    body.dataset.cover = on('showCover') ? 'on' : 'off';
    body.dataset.times = on('showTimes') ? 'on' : 'off';
    body.dataset.lyrics = on('showLyrics') ? 'on' : 'off';
    body.dataset.smooth = on('smooth') ? 'on' : 'off';

    const lines = Number(pick('lyricLines'));
    body.dataset.lines = String([1, 3, 5].includes(lines) ? lines : 3);
    body.dataset.hideIdle = on('hideIdle') ? 'yes' : 'no';

    const idle = pick('idleText');
    body.dataset.idleText = typeof idle === 'string' ? idle.slice(0, 60) : '';
  }

  /** lyricStyle -> data-lyric, so the stylesheet reads a shorter name. */
  function attr(key) {
    return key === 'lyricStyle' ? 'lyric' : key;
  }

  function connect() {
    // Relative, so the token in our own path travels with it and never has to
    // be written down anywhere in this file.
    const feed = new EventSource('feed');

    feed.addEventListener('message', (event) => {
      let next;
      try {
        next = JSON.parse(event.data);
      } catch {
        return;
      }
      receive(next);
    });

    // EventSource reconnects by itself; this only marks the gap so the page can
    // fade rather than freeze on a song that stopped minutes ago.
    feed.addEventListener('error', () => {
      if (state && state.playing) body.dataset.stale = 'yes';
    });
  }

  function receive(next) {
    const newTrack = !state || next.title !== state.title || next.mode !== state.mode;

    // Cheap and idempotent, so it simply runs on every message rather than
    // needing to work out whether a setting moved.
    applySettings(next.settings);

    state = next;
    receivedAt = performance.now();
    delete body.dataset.stale;

    if (!newTrack) {
      paint();
      return;
    }

    cueIndex = 0;
    lastRenderedLine = -1;
    onScreen = [];

    // A different song is a change of subject, so the block fades out, swaps,
    // and fades back rather than rewriting itself word by word under the eye.
    if (body.dataset.smooth === 'off') {
      paint();
      return;
    }

    els.wrap.classList.add('changing');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => {
      paint();
      els.wrap.classList.remove('changing');
    }, SWAP_MS);
  }

  /** Everything that only changes when a message arrives. */
  function paint() {
    if (!state) {
      body.dataset.state = 'waiting';
      return;
    }

    if (!state.playing) {
      const text = idleText();
      // Nothing to say and nothing wanted: fade out entirely rather than leave
      // an empty box sitting in the scene.
      body.dataset.state = text ? 'idle' : 'gone';
      els.idle.textContent = text;
      return;
    }

    body.dataset.state = 'playing';

    els.title.textContent = state.privacy ? '' : state.title || '';
    els.artist.textContent = state.privacy ? '' : state.artist || '';
    els.total.textContent = clock(state.duration);

    if (state.cover) els.cover.setAttribute('src', state.cover);
    else els.cover.removeAttribute('src');

    // A title of unknown length should take about the same time to cross.
    if (body.dataset.style === 'ticker') {
      const seconds = Math.min(40, Math.max(10, (state.title || '').length * 0.35));
      document.documentElement.style.setProperty('--ticker-seconds', `${seconds}s`);
    }

    renderLyrics(currentCue(position()));
  }

  /**
   * The smooth clock, and a floor under it.
   *
   * requestAnimationFrame is what makes the bar move rather than step, but a
   * browser stops calling it entirely while the page is hidden — which is every
   * scene OBS is not currently showing. The interval is slow enough to cost
   * nothing and keeps the time honest for the moment the scene comes back;
   * advance() does the same work either way and is safe to call twice.
   */
  function tick() {
    requestAnimationFrame(tick);
    advance();
  }

  function advance() {
    if (!state || !state.playing) return;

    const at = position();

    if (state.duration > 0) {
      els.fill.style.width = `${Math.min(100, (at / state.duration) * 100)}%`;
    }
    els.elapsed.textContent = clock(at);

    const index = currentCue(at);
    if (index !== lastRenderedLine) renderLyrics(index);

    // The agent went quiet mid-song: hold what is on screen for a moment, then
    // fade. Freezing on a song that ended minutes ago is worse than nothing.
    if (body.dataset.stale === 'yes' && performance.now() - receivedAt > GONE_AFTER_MS) {
      body.dataset.state = 'gone';
    }
  }

  /** Where the song is now, from the anchor the agent stamped. */
  function position() {
    if (!state) return 0;
    if (state.paused) return state.position || 0;
    return (state.position || 0) + (performance.now() - receivedAt) / 1000;
  }

  /**
   * Which cue is current, walking forward.
   *
   * A binary search per frame would be correct and pointless: playback moves
   * forward, so the answer is nearly always the one from last frame or the one
   * after it. A seek backwards resets and walks again, which happens rarely
   * enough that it does not matter.
   */
  function currentCue(at) {
    if (!state || state.mode !== 'timed' || !state.cues?.length) return -1;

    if (cueIndex > 0 && state.cues[cueIndex] && state.cues[cueIndex].t > at) cueIndex = 0;
    while (cueIndex + 1 < state.cues.length && state.cues[cueIndex + 1].t <= at) cueIndex += 1;
    return state.cues[cueIndex] && state.cues[cueIndex].t <= at ? cueIndex : -1;
  }

  /**
   * Draw the visible window of lines.
   *
   * Rebuilt each time rather than diffed, because the set shifts by one and the
   * cheapest correct thing is to start over. What is not thrown away is the
   * knowledge of which texts were already up: a line that was on screen a
   * moment ago must not animate in again, or every change would ripple through
   * all of them at once.
   */
  function renderLyrics(index) {
    lastRenderedLine = index;
    els.lyrics.textContent = '';

    if (!state || state.privacy) {
      onScreen = [];
      return;
    }

    // Subtitles arrive one at a time, so there is nothing to read ahead and the
    // page must not pretend otherwise.
    if (state.mode === 'caption') {
      const texts = state.line ? [state.line] : [];
      if (texts.length) els.lyrics.appendChild(line(state.line, true, !onScreen.includes(state.line)));
      onScreen = texts;
      return;
    }

    if (state.mode !== 'timed' || index < 0) {
      onScreen = [];
      return;
    }

    const count = Number(body.dataset.lines) || 3;
    // With one line there is nothing to lead with; with more, keep one behind
    // so the reader can see what was just sung.
    const before = count > 1 ? 1 : 0;

    const texts = [];
    for (let i = index - before; i < index - before + count; i++) {
      const cue = state.cues[i];
      if (!cue) continue;
      texts.push(cue.text);
      els.lyrics.appendChild(line(cue.text, i === index, !onScreen.includes(cue.text)));
    }
    onScreen = texts;
  }

  /**
   * One line, optionally arriving.
   *
   * `entering` is removed on the next frame rather than immediately: the
   * displaced state has to be painted once before the transition to the settled
   * one means anything.
   */
  function line(text, current, arriving) {
    const div = document.createElement('div');
    div.className = current ? 'line now-line' : 'line';
    div.textContent = text;

    if (arriving && body.dataset.smooth !== 'off') {
      div.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => div.classList.remove('entering')));
    }
    return div;
  }

  /**
   * What to show with nothing playing.
   *
   * Before the first message ever arrives the page shows nothing at all — a
   * banner burned into a stream because the agent had not started yet would be
   * the worst of the three idle cases.
   */
  function idleText() {
    if (body.dataset.hideIdle !== 'no') return '';
    return body.dataset.idleText || '';
  }

  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }
})();
