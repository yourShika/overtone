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

  /**
   * A quiet stretch long enough to be worth marking, in seconds.
   *
   * Below this the next line is already on its way and dots would flash for an
   * instant, which is worse than nothing. Above it the overlay would otherwise
   * sit on a line that finished ten seconds ago and look broken.
   */
  const GAP_MIN = 4;

  /** How long a sung line keeps the stage after its cue, before the dots take over. */
  const LINE_HOLD = 2.5;

  /** The most of an intro worth counting down; before that, nothing. */
  const GAP_MAX = 12;

  /** Where each dot starts to light, as a share of the wait. */
  const DOT_STARTS = [0, 0.3, 0.6];
  /** Long enough to read as a change of subject, short enough not to miss a line. */
  const SWAP_MS = 260;

  let state = null;
  let receivedAt = 0;
  /** Walks forward through the cue list; never searches backwards. */
  let cueIndex = 0;
  let lastRenderedLine = -1;
  /** Cue text currently on screen, so only genuinely new lines animate in. */
  let onScreen = [];
  /** Whether a dots line is currently part of the block. */
  let gapShown = false;
  /** The dots row the song is currently inside, so the frame loop can fill it. */
  let activeDots = null;
  /**
   * The subtitle lines seen on this track, oldest first.
   *
   * Subtitles arrive one at a time and there is nothing to read ahead, so
   * without this the block held a single line however many rows were asked for.
   * Keeping what has already been said fills the same window with the same
   * animation — which is what somebody watching a stream reads anyway, having
   * looked away for a moment.
   */
  let captions = [];
  /** Enough to fill any window the panel offers, and no transcript. */
  const CAPTION_HISTORY = 12;
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

    // Remembered here rather than in the drawing, which runs several times per
    // message and would file the same line again each time.
    if (next.mode === 'caption' && next.line && captions[captions.length - 1] !== next.line) {
      captions.push(next.line);
      if (captions.length > CAPTION_HISTORY) captions.shift();
    }

    if (!newTrack) {
      paint();
      return;
    }

    cueIndex = 0;
    lastRenderedLine = -1;
    onScreen = [];
    captions = [];

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

    const at = position();
    renderLyrics(currentCue(at), gapAt(at));
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
    const gap = gapAt(at);

    // The block is rebuilt when a line changes or when the dots come and go;
    // in between, only the dots themselves move.
    if (index !== lastRenderedLine || (gap !== null) !== gapShown) {
      renderLyrics(index, gap);
    } else if (gap !== null) {
      fillDots(activeDots, gap);
    }

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
  /**
   * The wait before the next line, if there is one worth showing.
   *
   * Three cases, all read off the cue list rather than announced by the agent:
   * the intro before the first line, an explicitly empty cue, and a long
   * stretch after a line has had its moment. Returns how far through that wait
   * we are, from 0 to 1, or null when a line should simply be on screen.
   */
  /**
   * The stretch of silence after cue i, if it is long enough to be worth
   * showing. Pass -1 to ask about the intro, before the first line.
   *
   * This is a fact about the song, not about where the playhead is: the wait
   * between two lines is there whether or not it is happening right now. That
   * is what lets it be a row of the lyrics rather than something conjured up
   * for the duration of the silence and thrown away afterwards.
   */
  function waitWindow(i) {
    if (!state || state.mode !== 'timed' || !state.cues?.length) return null;

    // Only the tail of a long intro is counted down — a two-minute instrumental
    // opening should not show dots for two minutes.
    if (i < 0) {
      const first = state.cues[0].t;
      const from = Math.max(0, first - GAP_MAX);
      // Whether the intro is long enough to be worth a countdown — not how much
      // of it is left. Measuring what remains made the dots quit four seconds
      // before the first line instead of handing over to it.
      return first - from > GAP_MIN ? { from, to: first } : null;
    }

    const cue = state.cues[i];
    const next = state.cues[i + 1];
    if (!cue || !next) return null;

    // An empty cue is the file saying "nothing here" outright.
    const from = cue.text.trim() ? cue.t + LINE_HOLD : cue.t;
    return next.t - from > GAP_MIN ? { from, to: next.t } : null;
  }

  function gapAt(at) {
    const wait = waitWindow(currentCue(at));
    return wait ? progress(at, wait.from, wait.to) : null;
  }

  /** Where the clock sits between two times, clamped, or null before it starts. */
  function progress(at, from, to) {
    if (at < from) return null;
    return Math.max(0, Math.min(1, (at - from) / (to - from)));
  }

  /**
   * Draw the visible lines, and the dots when there is a wait.
   *
   * The dots go *in* the block, in the slot the missing line will occupy, so
   * nothing shifts when the line finally lands — it simply replaces them:
   *
   *     … the line just sung
   *     · · ·
   *     the line coming next
   */
  /**
   * What a row of dots is called when we are tracking what is on screen.
   *
   * One name per wait, because a song has several and they have to be told
   * apart: two rows sharing a name would look to the animation like the same
   * row staying put. The prefix cannot collide with a lyric — no lyrics file
   * contains a null byte.
   */
  const DOTS = '\u0000dots';
  const dotsKey = (i) => DOTS + i;
  const isDots = (row) => typeof row === 'string' && row.startsWith(DOTS);

  /**
   * Draw the visible rows.
   *
   * The dots are one of those rows rather than an extra beneath them, which is
   * the whole trick: the window is always the same height, the dots hold the
   * place of the line that has not arrived, and when it does it moves into that
   * place the way any line moves into any other — same easing, same slide, same
   * scaling under the lifted style. Nothing about them is special-cased in the
   * animation, because they are not special.
   *
   *     … the line just sung
   *     · · ·          <- the active row while the song is quiet
   *     the line coming next
   */
  function renderLyrics(index, gap) {
    lastRenderedLine = index;
    gapShown = gap !== null && gap !== undefined;

    if (!state || state.privacy) {
      els.lyrics.textContent = '';
      onScreen = [];
      gapShown = false;
      return;
    }

    // Subtitles arrive one at a time, so there is nothing to read ahead — the
    // window is filled with what has already been said and anchored at the
    // bottom, the way live captions run. A pause is a wait of unknown length:
    // dots, but breathing rather than filling, because there is nothing honest
    // to fill towards.
    if (state.mode === 'caption') {
      const rows = captions.slice();
      if (!state.line) rows.push(dotsKey(-1));

      const count = Number(body.dataset.lines) || 3;
      const from = Math.max(0, rows.length - count);
      const window = rows.slice(from);

      draw(window, window.length - 1, null);
      gapShown = !state.line;
      return;
    }

    if (state.mode !== 'timed') {
      els.lyrics.textContent = '';
      onScreen = [];
      gapShown = false;
      return;
    }

    // One flat list of rows: every cue that has words, plus the dots standing
    // where the wait is. Windowing over that keeps the height constant whether
    // the song is between lines or in the middle of one.
    const rows = [];
    let active = -1;
    let lastSung = -1;

    // The wait before the first line is a row of the song like any other.
    if (waitWindow(-1)) {
      if (index < 0 && gapShown) active = 0;
      rows.push(dotsKey(-1));
    }

    for (let i = 0; i < state.cues.length; i++) {
      const cue = state.cues[i];
      // An empty cue is the file marking a pause, not a line to draw — the dots
      // for that wait stand where it would have been.
      if (cue.text.trim()) {
        if (i === index && !gapShown) active = rows.length;
        rows.push(cue.text);
        if (i <= index) lastSung = rows.length - 1;
      }

      // Every long wait gets its row, not just the one being waited out. That
      // is the whole point: the row is already there before the silence starts
      // and stays afterwards, so it travels up through the window with the
      // words instead of appearing and vanishing in place.
      if (waitWindow(i)) {
        if (i === index && gapShown) active = rows.length;
        rows.push(dotsKey(i));
        // A wait already lived through is behind us; the one after the current
        // line has not begun, even when the line itself has been sung.
        if (i < index) lastSung = rows.length - 1;
      }
    }

    // The playhead can sit on a cue that produced no row: an empty one marking a
    // pause too long to count down, so there are neither words nor dots to point
    // at. The last line actually sung is what the block should still be showing —
    // without this the window fell back to zero and the overlay jumped to the
    // first lines of the song.
    if (active < 0) active = lastSung;

    const count = Number(body.dataset.lines) || 3;
    // Keep what is being sung in the middle: with three rows that is one above
    // and one below, as before; with five it is two and two, rather than the
    // line sitting second from the top with three rows trailing under it.
    //
    // Always at least one row above, though, or a finished wait would have
    // nowhere to move to and would blink out where it stood — which is the
    // thing being fixed here.
    const before = count > 1 ? Math.max(1, Math.floor((count - 1) / 2)) : 0;
    // Keep the window full even at the end, where there is nothing left to
    // lead with: slide it back rather than let the block shrink, which under a
    // centred anchor would drag every line upward on the last verse.
    const from = Math.min(Math.max(0, active - before), Math.max(0, rows.length - count));

    // Nothing to point at at all — every cue in the file is empty.
    if (active < 0) {
      els.lyrics.textContent = '';
      onScreen = [];
      return;
    }

    draw(rows.slice(from, from + count), active - from, gap);
  }

  /** Put a window of rows on screen, animating in whatever is new. */
  function draw(rows, activeAt, gap) {
    els.lyrics.textContent = '';
    activeDots = null;

    for (let i = 0; i < rows.length; i++) {
      const arriving = !onScreen.includes(rows[i]);

      if (!isDots(rows[i])) {
        els.lyrics.appendChild(line(rows[i], i === activeAt, arriving));
        continue;
      }

      // A wait that has been lived through shows full, one still ahead shows at
      // rest, and the one happening now fills. So the dots carry their own
      // history up the block instead of resetting as they move.
      const amount = i === activeAt ? gap : i < activeAt ? 1 : 0;
      const div = dotsLine(amount, i === activeAt, arriving);
      if (i === activeAt) activeDots = div;
      els.lyrics.appendChild(div);
    }
    onScreen = rows;
  }

/**
   * A row of dots, built the same way a row of words is.
   *
   * Same element, same classes, same entering treatment — so every lyric style
   * applies to it without knowing it exists.
   */
  function dotsLine(amount, current, arriving) {
    const div = document.createElement('div');
    div.className = current ? 'line now-line dots-line' : 'line dots-line';
    if (amount === null || amount === undefined) div.classList.add('waiting');
    div.style.setProperty('--row', String(els.lyrics.childElementCount));

    for (let i = 0; i < DOT_STARTS.length; i++) div.appendChild(document.createElement('i'));
    fillDots(div, amount);

    if (arriving && body.dataset.smooth !== 'off') {
      div.classList.add('entering');
      settle(div);
    }
    return div;
  }

  /**
   * How full each dot is.
   *
   * Written from JS rather than computed in CSS: it was a clamp() around a
   * calc() over a live custom property, which is legal and did not work — the
   * substituted number never made it back through the calc, so every dot sat at
   * the floor while the value climbed. Three style writes a frame cost nothing.
   */
  function fillDots(div, amount) {
    // An unknown wait cannot be filled honestly, so the CSS breathes instead.
    if (!div || amount === null || amount === undefined) return;

    for (let i = 0; i < DOT_STARTS.length; i++) {
      const dot = div.children[i];
      if (!dot) continue;
      const share = amount - DOT_STARTS[i];
      dot.style.opacity = String(clamp(share * 3.2, 0.22, 1));
      dot.style.transform = `scale(${clamp(0.62 + share * 1.6, 0.62, 1.18)})`;
    }
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
    div.style.setProperty('--row', String(els.lyrics.childElementCount));

    if (arriving && body.dataset.smooth !== 'off') {
      div.classList.add('entering');
      settle(div);
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

/**
   * Let a row settle into place.
   *
   * Two frames, because the displaced state has to be painted once before the
   * transition to the settled one means anything — and a timer beside them,
   * because requestAnimationFrame is not called at all while the page is
   * hidden. Without the timer a line added while the scene was off-screen kept
   * its entering state, which is opacity zero: invisible, for as long as OBS
   * did not show that scene.
   */
  function settle(div) {
    const done = () => div.classList.remove('entering');
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, 60);
  }

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }
})();
