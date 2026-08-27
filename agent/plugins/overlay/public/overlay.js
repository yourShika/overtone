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
 * Everything from the feed is written with textContent. It is a song title
 * somebody else chose, arriving over a socket, and this page has no business
 * treating it as anything but text.
 */

(() => {
  const $ = (id) => document.getElementById(id);

  const body = document.body;
  const els = {
    cover: $('cover'),
    title: $('title'),
    artist: $('artist'),
    elapsed: $('elapsed'),
    total: $('total'),
    fill: $('fill'),
    lyrics: $('lyrics'),
    idle: $('idle'),
  };

  /** Styles a query string may ask for. Anything else is ignored. */
  const STYLES = ['card', 'bar', 'lyrics', 'ticker'];
  const BACKGROUNDS = ['none', 'soft', 'solid'];

  /** How long a silent agent may be gone before the overlay fades. */
  const GONE_AFTER_MS = 10_000;

  let feed = null;
  /** The last payload, and when this page received it. */
  let state = null;
  let receivedAt = 0;
  /** Walks forward through the cue list; never searches backwards. */
  let cueIndex = 0;
  let lastRenderedLine = -1;

  start();

  function start() {
    applyQuery();
    connect();
    requestAnimationFrame(tick);
    setInterval(advance, 1000);
    // Coming back into view: repaint at once rather than waiting for a frame.
    document.addEventListener('visibilitychange', advance);
  }

  /**
   * Per-source overrides.
   *
   * The panel sets the defaults for everyone; the query string lets one scene
   * run the bar while another runs the lyrics from the same address. Read from
   * a fixed list rather than trusted — this is in a URL anyone can edit.
   */
  function applyQuery() {
    const params = new URLSearchParams(location.search);
    const on = (key) => params.get(key) !== 'false';

    const style = params.get('style');
    if (STYLES.includes(style)) body.dataset.style = style;

    const background = params.get('background');
    if (BACKGROUNDS.includes(background)) body.dataset.background = background;

    const scale = Number(params.get('scale'));
    if (Number.isFinite(scale) && scale >= 60 && scale <= 200) {
      document.documentElement.style.setProperty('--scale', String(scale / 100));
    }

    // #rrggbb only. A colour goes straight into a custom property, and a custom
    // property is somewhere CSS will happily accept far more than a colour.
    const accent = params.get('accent');
    if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
      document.documentElement.style.setProperty('--accent', accent);
    }

    // The switches. Absent means on, because that is what the manifest
    // defaults to and an absent parameter is one the panel chose not to send.
    body.dataset.cover = on('showCover') ? 'on' : 'off';
    body.dataset.times = on('showTimes') ? 'on' : 'off';
    body.dataset.lyrics = on('showLyrics') ? 'on' : 'off';

    const lines = Number(params.get('lyricLines'));
    body.dataset.lines = String([1, 3, 5].includes(lines) ? lines : 3);

    // hideIdle false means the user wants something on screen instead, which is
    // only meaningful if they also wrote what.
    body.dataset.hideIdle = params.get('hideIdle') === 'false' ? 'no' : 'yes';
  }

  function connect() {
    // Relative, so the token in our own path travels with it and never has to
    // be written down anywhere in this file.
    feed = new EventSource('feed');

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

    state = next;
    receivedAt = performance.now();
    delete body.dataset.stale;

    if (newTrack) {
      cueIndex = 0;
      lastRenderedLine = -1;
    }
    paint();
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

  function renderLyrics(index) {
    lastRenderedLine = index;
    els.lyrics.textContent = '';

    if (!state || state.privacy) return;

    // Subtitles arrive one at a time, so there is nothing to read ahead and the
    // page must not pretend otherwise.
    if (state.mode === 'caption') {
      if (state.line) els.lyrics.appendChild(line(state.line, true));
      return;
    }

    if (state.mode !== 'timed' || index < 0) return;

    const count = Number(body.dataset.lines) || 3;
    const before = count > 1 ? 1 : 0;

    for (let i = index - before; i < index - before + count; i++) {
      const cue = state.cues[i];
      if (!cue) continue;
      els.lyrics.appendChild(line(cue.text, i === index));
    }
  }

  function line(text, current) {
    const div = document.createElement('div');
    div.className = current ? 'line now-line' : 'line';
    div.textContent = text;
    return div;
  }

  /**
   * What to show with nothing playing.
   *
   * Three cases, kept apart. Before the first message ever arrives the page
   * shows nothing at all — a banner burned into a stream because the agent had
   * not started yet would be the worst of them.
   */
  function idleText() {
    if (body.dataset.hideIdle !== 'no') return '';
    return new URLSearchParams(location.search).get('idleText') || '';
  }

  function clock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }
})();
