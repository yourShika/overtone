'use strict';

/**
 * Tests for the pure logic — everything that does not need Electron or a live
 * Discord socket. Run with `npm test`.
 *
 * These cover the parts that are easy to get subtly wrong and impossible to
 * eyeball in the running app: LRC timing maths, the rate limiter's window, and
 * the title cleaner's decisions about which brackets matter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { parseLrc, lineAt, nextLineTime, lyricWindow, buildBlocks, blockAt } = require('../src/lyrics/lrc');
const { parseTrack, stripNoise, cleanArtist, formatArtists } = require('../src/lyrics/trackparse');
const { buildActivity } = require('../src/discord/activity');
const { PresenceController } = require('../src/discord/presence');
const { Session } = require('../src/session');
const { upscaleGoogleArt } = require('../src/thumbnails');
const { DEFAULTS, CONFIG_VERSION, migrate } = require('../src/config');

// ------------------------------------------------------------------ LRC parser

test('parseLrc reads timestamps and sorts them', () => {
  const lines = parseLrc(['[00:12.34]Erste Zeile', '[00:05.00]Frühere Zeile', '[01:00.5]Später'].join('\n'));

  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.time),
    [5, 12.34, 60.5],
  );
  assert.equal(lines[0].text, 'Frühere Zeile');
});

test('parseLrc expands a line carrying several timestamps', () => {
  const lines = parseLrc('[00:10.00][01:20.00][02:30.00]Refrain');

  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.text === 'Refrain'));
  assert.deepEqual(
    lines.map((l) => l.time),
    [10, 80, 150],
  );
});

test('parseLrc ignores metadata tags and keeps blank cues', () => {
  const lines = parseLrc(['[ar:Some Artist]', '[ti:Some Song]', '[00:03.00]', '[00:08.00]Text'].join('\n'));

  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, ''); // instrumental marker, deliberately empty
  assert.equal(lines[1].text, 'Text');
});

test('parseLrc treats a mid-line bracket as lyric content, not a cue', () => {
  const lines = parseLrc('[00:10.00]Zeile [00:20.00] mit Klammer');

  assert.equal(lines.length, 1);
  assert.equal(lines[0].time, 10);
  assert.equal(lines[0].text, 'Zeile [00:20.00] mit Klammer');
});

// -------------------------------------------------------------------- lineAt

const SAMPLE = parseLrc(
  ['[00:00.00]Eins', '[00:04.00]Zwei', '[00:08.00]Drei', '[00:40.00]Nach der Pause'].join('\n'),
);

test('lineAt picks the line that is current', () => {
  assert.equal(lineAt(SAMPLE, 0).text, 'Eins');
  assert.equal(lineAt(SAMPLE, 3.9).text, 'Eins');
  assert.equal(lineAt(SAMPLE, 4).text, 'Zwei');
  assert.equal(lineAt(SAMPLE, 7.5).text, 'Zwei');
  assert.equal(lineAt(SAMPLE, 9).text, 'Drei');
});

test('lineAt returns null before the first cue', () => {
  assert.equal(lineAt(parseLrc('[00:20.00]Spät'), 5), null);
});

test('lineAt drops a line that has been held through a long instrumental', () => {
  // "Drei" is current at 0:08 but the next cue is 32 s away — after the hold
  // window it must clear rather than freeze on the profile.
  assert.equal(lineAt(SAMPLE, 10).text, 'Drei');
  assert.equal(lineAt(SAMPLE, 30), null);
  assert.equal(lineAt(SAMPLE, 41).text, 'Nach der Pause');
});

test('lineAt applies the configured offset', () => {
  // With 1.5 s lead-in, the line at 4.0 s shows from 2.5 s onwards.
  assert.equal(lineAt(SAMPLE, 2.6, { offset: 1.5 }).text, 'Zwei');
  assert.equal(lineAt(SAMPLE, 2.6, { offset: 0 }).text, 'Eins');
});

test('nextLineTime reports the upcoming boundary', () => {
  // SAMPLE cues sit at 0, 4, 8 and 40 seconds.
  assert.equal(nextLineTime(SAMPLE, 0), 4);
  assert.equal(nextLineTime(SAMPLE, 3.9), 4);
  assert.equal(nextLineTime(SAMPLE, 4), 8);
  assert.equal(nextLineTime(SAMPLE, 9), 40, 'auch über eine lange Pause hinweg');
  assert.equal(nextLineTime(SAMPLE, 41), null, 'nach der letzten Zeile gibt es keine mehr');
});

test('nextLineTime copes with empty input', () => {
  assert.equal(nextLineTime([], 5), null);
  assert.equal(nextLineTime(null, 5), null);
});

test('lineAt copes with empty input', () => {
  assert.equal(lineAt([], 10), null);
  assert.equal(lineAt(null, 10), null);
});

// --------------------------------------------------------- combining lines

const FAST = parseLrc(
  [
    '[00:00.00]Eins',
    '[00:02.00]Zwei',
    '[00:04.00]Drei',
    '[00:06.00]Vier',
    '[00:20.00]Nach der Pause',
  ].join('\n'),
);

test('lyricWindow merges lines that a single update has to cover', () => {
  // 4 s of reach at 0 s covers the cues at 0 and 2 — without merging, "Zwei"
  // would never be shown at all.
  const view = lyricWindow(FAST, 0, { windowSeconds: 4, maxChars: 126 });

  assert.equal(view.text, 'Eins · Zwei');
  assert.equal(view.nextTime, 4, 'die nächste Grenze ist die erste NICHT gezeigte Zeile');
});

test('lyricWindow merges nothing when the reach is zero', () => {
  const view = lyricWindow(FAST, 0, { windowSeconds: 0, maxChars: 126 });

  assert.equal(view.text, 'Eins');
  assert.equal(view.nextTime, 2);
});

test('lyricWindow never truncates — a line that does not fit is left out', () => {
  const long = parseLrc(['[00:00.00]' + 'A'.repeat(60), '[00:02.00]' + 'B'.repeat(60)].join('\n'));

  // 60 + 3 + 60 = 123 fits in 126…
  const fits = lyricWindow(long, 0, { windowSeconds: 4, maxChars: 126 });
  assert.equal(fits.text.length, 123);
  assert.equal(fits.text.includes(' · '), true);

  // …but not in 100, so the second line waits rather than being cut.
  const tight = lyricWindow(long, 0, { windowSeconds: 4, maxChars: 100 });
  assert.equal(tight.text, 'A'.repeat(60));
  assert.equal(tight.nextTime, 2, 'die ausgelassene Zeile bleibt das nächste Ziel');
});

test('lyricWindow stops at an instrumental marker', () => {
  const withGap = parseLrc(
    ['[00:00.00]Eins', '[00:01.00]', '[00:02.00]Nach der Stille'].join('\n'),
  );
  const view = lyricWindow(withGap, 0, { windowSeconds: 4, maxChars: 126 });

  assert.equal(view.text, 'Eins', 'über eine bewusste Pause hinweg wird nicht geklebt');
  assert.equal(view.nextTime, 1);
});

test('lyricWindow merge strength scales with the reach, and never overruns the budget', () => {
  // Mirrors the three UI levels against a 4 s update interval.
  const levels = [
    { reach: 0, expected: 1 },
    { reach: 4, expected: 2 },
    { reach: 6, expected: 3 },
    { reach: 8, expected: 4 },
  ];

  for (const { reach, expected } of levels) {
    const view = lyricWindow(FAST, 0, { windowSeconds: reach, maxChars: 126 });
    const count = view.text.split(' · ').length;
    assert.equal(count, expected, `Reichweite ${reach}s sollte ${expected} Zeilen liefern`);
    assert.ok(view.text.length <= 126, 'das Zeichenbudget muss auf jeder Stufe halten');
  }
});

test('lyricWindow stops at the reach, not at the character budget', () => {
  // Cues at 0, 2, 4, 6 — a 5 s reach covers three of them.
  const view = lyricWindow(FAST, 0, { windowSeconds: 5, maxChars: 126 });

  assert.equal(view.text, 'Eins · Zwei · Drei');
  assert.equal(view.nextTime, 6);
});

test('lyricWindow does not reach across a long silence', () => {
  const view = lyricWindow(FAST, 6, { windowSeconds: 4, maxChars: 126 });

  assert.equal(view.text, 'Vier', 'die Zeile bei 20 s liegt weit außerhalb');
  assert.equal(view.nextTime, 20);
});

test('lyricWindow reports the next cue even when nothing is showing', () => {
  const late = parseLrc('[00:30.00]Spät');
  const view = lyricWindow(late, 0, { windowSeconds: 4, maxChars: 126 });

  assert.equal(view.text, null);
  assert.equal(view.nextTime, 30);
});

test('lyricWindow honours the offset when merging', () => {
  // At 1.6 s with a 0.5 s lead-in the effective position is 2.1 s, so the
  // current line is "Zwei" and the window reaches "Drei".
  const view = lyricWindow(FAST, 1.6, { offset: 0.5, windowSeconds: 4, maxChars: 126 });

  assert.equal(view.text, 'Zwei · Drei · Vier');
});

// ------------------------------------------------------- activity header name

test('formatArtists normalises collaboration markers to the comma form', () => {
  assert.equal(formatArtists('doli x szevczor x yokinashi'), 'doli, szevczor, yokinashi');
  assert.equal(formatArtists('Sam Smith & Normani'), 'Sam Smith, Normani');
  assert.equal(formatArtists('Drake feat. 21 Savage'), 'Drake, 21 Savage');
  assert.equal(formatArtists('Bring Me The Horizon'), 'Bring Me The Horizon');
  assert.equal(formatArtists(''), '');
});

test('formatArtists drops repeats rather than listing a name twice', () => {
  assert.equal(formatArtists('Doli x Doli'), 'Doli');
});

test('buildActivity fills the header from the template', () => {
  const activity = buildActivity({
    state: {
      ...BASE_STATE,
      title: 'doli x szevczor x yokinashi - 162020',
      artist: '',
      channel: 'Doli',
    },
    config: { ...DEFAULTS, activityName: '{artist} - {title}' },
  });

  assert.equal(activity.name, 'doli, szevczor, yokinashi - 162020');
});

test('buildActivity omits the header when no template is set', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, activityName: '' },
  });

  assert.equal(activity.name, undefined, 'ohne Template bleibt der Application-Name stehen');
});

test('buildActivity never puts the title in the header in privacy mode', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, activityName: '{artist} - {title}', privacyMode: true },
  });

  assert.equal(activity.name, undefined);
});

test('buildActivity trims a separator left by an empty placeholder', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, title: 'Irgendein Video ohne Trenner', artist: '', channel: '' },
    config: { ...DEFAULTS, activityName: '{artist} - {title}' },
  });

  assert.equal(activity.name, 'Irgendein Video ohne Trenner');
});

test('buildActivity clamps an over-long header', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, title: 'A'.repeat(300), artist: '', channel: '' },
    config: { ...DEFAULTS, activityName: '{title}' },
  });

  assert.ok(activity.name.length <= 128);
});

// ---------------------------------------------------- state badge + browsing

const ICONS = DEFAULTS.stateIconBase;

test('the badge names the playback state', () => {
  // Every tooltip names the app: hovering the badge is the only way someone
  // looking at an unfamiliar presence can find out what produced it.
  const cases = [
    [{}, 'playing.png', 'YouTube · Overtone'],
    [{ paused: true }, 'paused.png', 'Paused · Overtone'],
    [{ live: true, duration: 0 }, 'live.png', 'Live · Overtone'],
    [{ loop: true }, 'loop.png', 'Repeat · Overtone'],
  ];

  for (const [patch, file, text] of cases) {
    const activity = buildActivity({ state: { ...BASE_STATE, ...patch }, config: DEFAULTS });
    assert.equal(activity.assets.small_image, `${ICONS}/${file}`);
    assert.equal(activity.assets.small_text, text);
  }
});

test('paused outranks looping — the pause is the thing worth knowing', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, paused: true, loop: true },
    config: DEFAULTS,
  });
  assert.equal(activity.assets.small_image, `${ICONS}/paused.png`);
});

test('an uploaded asset key wins over the hosted icon', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, sourceAssetKey: 'mein_eigenes' },
  });
  assert.equal(activity.assets.small_image, 'mein_eigenes');
});

test('the badge can be switched off entirely', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, showStateBadge: false },
  });
  assert.equal(activity.assets.small_image, undefined);
});

test('browsing YouTube shows a presence without progress or buttons', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, idle: true, page: 'home', title: '' },
    config: DEFAULTS,
  });

  assert.equal(activity.type, 3, 'watching');
  assert.equal(activity.details, 'Browsing YouTube');
  assert.equal(activity.state, 'Home');
  assert.equal(activity.timestamps, undefined, 'kein Fortschritt ohne Wiedergabe');
  assert.equal(activity.buttons, undefined, 'kein Link auf ein Video, das nicht laeuft');
  assert.equal(activity.assets, undefined, 'kein Zustands-Badge ohne Zustand');
});

test('browsing names the kind of page', () => {
  const pages = [
    ['search', 'Search'],
    ['channel', 'Channel'],
    ['subscriptions', 'Subscriptions'],
    ['unknown-page', 'Browsing'],
  ];
  for (const [page, label] of pages) {
    const activity = buildActivity({
      state: { ...BASE_STATE, idle: true, page, title: '' },
      config: DEFAULTS,
    });
    assert.equal(activity.state, label);
  }
});

test('browsing can be switched off', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, idle: true, page: 'home', title: '' },
    config: { ...DEFAULTS, showWhenBrowsing: false },
  });
  assert.equal(activity, null);
});

test('a browsing state never carries a title through', () => {
  // Guards against the idle branch being skipped because a stale title lingers.
  const activity = buildActivity({
    state: { ...BASE_STATE, idle: true, page: 'home' },
    config: DEFAULTS,
  });
  assert.equal(activity.details, 'Browsing YouTube');
  assert.notEqual(activity.details, BASE_STATE.title);
});

// ------------------------------------------------------------- block mode

test('buildBlocks packs whole lines up to the budget', () => {
  const blocks = buildBlocks(FAST, { maxChars: 12 });

  // "Eins · Zwei" is 11 characters; adding "Drei" would exceed twelve.
  assert.equal(blocks[0].text, 'Eins · Zwei');
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks[0].end, 4, 'ein Block endet, wo der nächste beginnt');

  // A block may exceed the budget only when it holds a single line that is
  // itself too long — lines are never cut, exactly as in line mode.
  for (const block of blocks) {
    if (block.text.length > 12) {
      assert.equal(block.lines, 1, `zu lang, aber ${block.lines} Zeilen: ${block.text}`);
    }
  }
});

test('a block stands until its last line has been sung', () => {
  const blocks = buildBlocks(FAST, { maxChars: 12 });

  // Everything from 0 s up to the next block shows the same text — that is the
  // whole point: one update per paragraph instead of one per line.
  for (const position of [0, 1, 2, 3, 3.9]) {
    assert.equal(blockAt(blocks, position).text, 'Eins · Zwei', `bei ${position}s`);
  }
  assert.notEqual(blockAt(blocks, 4).text, 'Eins · Zwei');
});

test('blocks end at an instrumental marker', () => {
  const withGap = parseLrc(
    ['[00:00.00]Eins', '[00:01.00]', '[00:02.00]Danach', '[00:03.00]Noch was'].join('\n'),
  );
  const blocks = buildBlocks(withGap, { maxChars: 200 });

  assert.equal(blocks.length, 2, 'über eine bewusste Pause wird nicht gepackt');
  assert.equal(blocks[0].text, 'Eins');
  assert.equal(blocks[1].text, 'Danach · Noch was');
});

test('the last block runs to the end of the song', () => {
  const blocks = buildBlocks(FAST, { maxChars: 200 });
  assert.equal(blocks[blocks.length - 1].end, Infinity);
});

test('blockAt returns nothing before the first block', () => {
  const late = parseLrc('[00:30.00]Spät');
  assert.equal(blockAt(buildBlocks(late, { maxChars: 60 }), 5), null);
});

test('buildBlocks copes with empty input', () => {
  assert.deepEqual(buildBlocks([], { maxChars: 60 }), []);
  assert.deepEqual(buildBlocks(null, { maxChars: 60 }), []);
});

test('block mode spends far fewer updates than line mode', () => {
  // The reason block mode exists, stated as a number.
  const blocks = buildBlocks(FAST, { maxChars: 120 });
  assert.ok(
    blocks.length < FAST.length,
    `${blocks.length} Blöcke gegen ${FAST.length} Zeilen`,
  );
});

// ------------------------------------------------------- buffering freezes

test('a buffering video does not advance the position', () => {
  const session = new Session();
  const base = {
    source: 'youtube',
    videoId: 'x',
    title: 'T',
    url: 'u',
    duration: 200,
    playbackRate: 1,
    paused: false,
    live: false,
  };

  session.update({ ...base, buffering: true, position: 30 });
  const frozen = session.state.position;

  // Time passes; a stalled video is exactly where it was.
  session.receivedAt -= 5000;
  assert.equal(session.state.position, frozen, 'während des Puffern steht die Zeit');

  // Once data arrives it advances again.
  session.update({ ...base, buffering: false, position: 30 });
  session.receivedAt -= 5000;
  assert.ok(session.state.position > frozen, 'danach läuft sie weiter');
});

// ------------------------------------------------------- titles and language

test('decorative YouTube noise is stripped from what is shown', () => {
  const cases = [
    ['lullabyboy - where are you now? (lyrics)', 'lullabyboy - where are you now?'],
    ['Daft Punk - Instant Crush (Official Video)', 'Daft Punk - Instant Crush'],
    ['Some Song (Official Audio) [4K]', 'Some Song'],
  ];
  for (const [raw, expected] of cases) {
    const activity = buildActivity({ state: { ...BASE_STATE, title: raw }, config: DEFAULTS });
    assert.equal(activity.details, expected);
  }
});

test('brackets that carry meaning survive', () => {
  // The line this draws: "(Official Video)" says nothing about the recording,
  // "(Live at Wembley)" says which recording it is. Dropping the second would
  // misreport what someone is listening to.
  const keep = ['Artist - Title (Live at Wembley)', 'Track (Remastered 2011)', 'Song (prod. someone)'];
  for (const raw of keep) {
    const activity = buildActivity({ state: { ...BASE_STATE, title: raw }, config: DEFAULTS });
    assert.equal(activity.details, raw, `hätte bleiben müssen: ${raw}`);
  }
});

test('title cleaning can be switched off', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, title: 'Song (Official Video)' },
    config: { ...DEFAULTS, cleanTitles: false },
  });
  assert.equal(activity.details, 'Song (Official Video)');
});

test('a title that is nothing but noise is kept rather than emptied', () => {
  // Better a decorated title than none: an empty details line looks broken.
  const activity = buildActivity({
    state: { ...BASE_STATE, title: '(Official Music Video)' },
    config: DEFAULTS,
  });
  assert.ok(activity.details.length > 0);
});

test('the presence follows the chosen language', () => {
  const { setLocale } = require('../src/i18n');
  try {
    setLocale('pl');
    const activity = buildActivity({
      state: { ...BASE_STATE, idle: true, page: 'home', title: '' },
      config: DEFAULTS,
    });
    assert.equal(activity.state, 'Strona główna');
    assert.equal(activity.details, 'Przegląda YouTube');
  } finally {
    setLocale('en');
  }
});

// ---------------------------------------------------------------- trackparse

test('stripNoise removes promo brackets but keeps meaningful ones', () => {
  assert.equal(stripNoise('Song Title (Official Music Video)'), 'Song Title');
  assert.equal(stripNoise('Song Title [4K UHD]'), 'Song Title');
  assert.equal(stripNoise('Song Title (Remix)'), 'Song Title (Remix)');
  assert.equal(stripNoise('Song Title (Live at Wembley)'), 'Song Title (Live at Wembley)');
  assert.equal(stripNoise('Song Title (Acoustic Version)'), 'Song Title (Acoustic Version)');
});

test('cleanArtist strips VEVO, Topic and featured artists', () => {
  assert.equal(cleanArtist('DaftPunkVEVO'), 'DaftPunk');
  assert.equal(cleanArtist('Daft Punk - Topic'), 'Daft Punk');
  assert.equal(cleanArtist('Daft Punk feat. Pharrell'), 'Daft Punk');
  assert.equal(cleanArtist('Calvin Harris & Dua Lipa'), 'Calvin Harris');
});

test('parseTrack splits the common "Artist - Title" shape', () => {
  const result = parseTrack({
    source: 'youtube',
    title: 'Daft Punk - Instant Crush (Official Video) [HD]',
    channel: 'DaftPunkVEVO',
  });

  assert.equal(result.artist, 'Daft Punk');
  assert.equal(result.track, 'Instant Crush');
  assert.equal(result.confident, true);
});

test('parseTrack trusts a "- Topic" channel over the title', () => {
  const result = parseTrack({
    source: 'youtube',
    title: 'Instant Crush',
    channel: 'Daft Punk - Topic',
  });

  assert.equal(result.artist, 'Daft Punk');
  assert.equal(result.track, 'Instant Crush');
});

test('parseTrack does not duplicate the artist when the title repeats it', () => {
  const result = parseTrack({
    source: 'youtube',
    title: 'Daft Punk - Instant Crush',
    channel: 'Daft Punk - Topic',
  });

  assert.equal(result.artist, 'Daft Punk');
  assert.equal(result.track, 'Instant Crush');
});

test('parseTrack takes YouTube Music metadata verbatim', () => {
  const result = parseTrack({
    source: 'ytmusic',
    title: 'Instant Crush',
    artist: 'Daft Punk',
    channel: 'irrelevant',
  });

  assert.equal(result.artist, 'Daft Punk');
  assert.equal(result.track, 'Instant Crush');
  assert.equal(result.confident, true);
});

test('parseTrack falls back to the channel when there is no separator', () => {
  const result = parseTrack({
    source: 'youtube',
    title: 'Some Random Vlog',
    channel: 'Some Channel',
  });

  assert.equal(result.artist, 'Some Channel');
  assert.equal(result.track, 'Some Random Vlog');
  assert.equal(result.confident, false);
});

// ------------------------------------------------------------------- activity

const BASE_STATE = {
  source: 'youtube',
  videoId: 'dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artist: '',
  channel: 'Rick Astley',
  channelUrl: 'https://www.youtube.com/@RickAstleyYT',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  duration: 213,
  position: 30,
  playbackRate: 1,
  paused: false,
  live: false,
};

test('buildActivity produces title, channel, progress and a button', () => {
  const activity = buildActivity({ state: BASE_STATE, config: DEFAULTS });

  assert.equal(activity.type, 3); // watching
  assert.equal(activity.details, 'Never Gonna Give You Up');
  assert.equal(activity.state, 'by Rick Astley');
  assert.ok(activity.timestamps.start <= Date.now());
  assert.ok(activity.timestamps.end > Date.now());
  assert.equal(activity.assets.large_image, BASE_STATE.thumbnail);
  assert.equal(activity.buttons.length, 1);
  assert.equal(activity.buttons[0].url, BASE_STATE.url);
});

test('buildActivity puts the lyric in the second line', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: DEFAULTS,
    lyric: 'Never gonna let you down',
  });

  assert.equal(activity.state, '♪ Never gonna let you down');
});

test('buildActivity promotes the lyric to line 1 when configured', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, lyricsProminent: true },
    lyric: 'Never gonna let you down',
  });

  assert.equal(activity.details, '♪ Never gonna let you down');
  assert.equal(activity.state, 'Rick Astley – Never Gonna Give You Up');
});

test('buildActivity does not repeat an artist the title already carries', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, title: 'Daft Punk - Instant Crush', channel: 'Daft Punk' },
    config: { ...DEFAULTS, lyricsProminent: true },
    lyric: 'I didn’t want to be the one to forget',
  });

  assert.equal(activity.state, 'Daft Punk - Instant Crush');
});

test('buildActivity keeps the normal layout when there is no lyric', () => {
  // Prominence must not blank the first line on a track without lyrics.
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, lyricsProminent: true },
    lyric: null,
  });

  assert.equal(activity.details, 'Never Gonna Give You Up');
  assert.equal(activity.state, 'by Rick Astley');
});

test('buildActivity honours privacy mode over lyric prominence', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, lyricsProminent: true, privacyMode: true },
    lyric: 'Never gonna let you down',
  });

  assert.equal(activity.details, 'Watching something');
  assert.ok(!JSON.stringify(activity).includes('Never gonna'));
});

test('buildActivity emits the Listening type when forced', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, activityType: 'listening' },
  });

  assert.equal(activity.type, 2);
});

test('buildActivity uses Listening for YouTube Music in auto mode', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, source: 'ytmusic', artist: 'Rick Astley' },
    config: DEFAULTS,
  });

  assert.equal(activity.type, 2); // listening
  assert.equal(activity.state, 'Rick Astley');
});

test('buildActivity omits the end timestamp for live streams', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, live: true, duration: 0 },
    config: DEFAULTS,
  });

  assert.ok(activity.timestamps.start);
  assert.equal(activity.timestamps.end, undefined);
});

test('buildActivity drops timestamps while paused', () => {
  const activity = buildActivity({ state: { ...BASE_STATE, paused: true }, config: DEFAULTS });

  assert.equal(activity.timestamps, undefined);
  assert.equal(activity.assets.small_text, 'Paused · Overtone');
});

test('buildActivity hides everything identifying in privacy mode', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: { ...DEFAULTS, privacyMode: true },
  });

  assert.equal(activity.details, 'Watching something');
  assert.ok(!JSON.stringify(activity).includes('Never Gonna'));
  assert.ok(!JSON.stringify(activity).includes('dQw4w9WgXcQ'));
  assert.equal(activity.buttons, undefined);
});

test('buildActivity clamps overlong text to Discord limits', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, title: 'x'.repeat(400) },
    config: DEFAULTS,
  });

  assert.ok(activity.details.length <= 128);
  assert.ok(activity.details.endsWith('…'));
});

test('buildActivity rejects a non-http button target', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, url: 'javascript:alert(1)' },
    config: DEFAULTS,
  });

  assert.equal(activity.buttons, undefined);
});

test('buildActivity returns null when paused and hideWhenPaused is set', () => {
  const activity = buildActivity({
    state: { ...BASE_STATE, paused: true },
    config: { ...DEFAULTS, hideWhenPaused: true },
  });

  assert.equal(activity, null);
});

// ------------------------------------------------------------- lyric sourcing

/**
 * Mirrors main.js currentLyricLine(). Kept as a local copy because the real one
 * lives inside the Electron entry point and cannot be imported without Electron
 * — so the decision table is pinned here instead of going untested.
 */
function pickLyric({ lines, caption, source = 'auto', position = 0, offset = 0, paused = false }) {
  if (paused) return null;
  if (source !== 'captions' && lines?.length) {
    return lineAt(lines, position, { offset })?.text ?? null;
  }
  if (source !== 'lrclib' && caption) return caption;
  return null;
}

test('lyric source: database wins when it has the song', () => {
  const line = pickLyric({ lines: SAMPLE, caption: 'Untertitelzeile', position: 5 });
  assert.equal(line, 'Zwei');
});

test('lyric source: falls back to captions when the database has nothing', () => {
  const line = pickLyric({ lines: null, caption: 'KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU', position: 5 });
  assert.equal(line, 'KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU');
});

test('lyric source: captions-only mode ignores the database', () => {
  const line = pickLyric({ lines: SAMPLE, caption: 'Untertitelzeile', source: 'captions', position: 5 });
  assert.equal(line, 'Untertitelzeile');
});

test('lyric source: lrclib-only mode ignores captions', () => {
  const line = pickLyric({ lines: null, caption: 'Untertitelzeile', source: 'lrclib', position: 5 });
  assert.equal(line, null);
});

test('lyric source: an instrumental gap stays empty rather than borrowing a caption', () => {
  // 30 s sits in SAMPLE's long gap. Falling through to captions there would put
  // stray dialogue on the profile during an instrumental break.
  const line = pickLyric({ lines: SAMPLE, caption: 'Untertitelzeile', position: 30 });
  assert.equal(line, null);
});

test('lyric source: nothing while paused', () => {
  const line = pickLyric({ lines: SAMPLE, caption: 'Untertitelzeile', position: 5, paused: true });
  assert.equal(line, null);
});

test('lyric source: captions used while the database lookup is still running', () => {
  // lines === null means "not loaded yet" — the caption bridges the gap so the
  // user sees something immediately.
  const line = pickLyric({ lines: null, caption: 'Erste Zeile', position: 1 });
  assert.equal(line, 'Erste Zeile');
});

test('buildActivity renders a caption line like any other lyric', () => {
  const activity = buildActivity({
    state: BASE_STATE,
    config: DEFAULTS,
    lyric: 'KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU',
  });

  assert.equal(activity.state, '♪ KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU');
});

// ------------------------------------------------------------------ migration

test('migration clears the old fixed lead-in', () => {
  // A config written by v1, where 1.5 s was the shipped default.
  const values = { ...DEFAULTS, lyricsOffset: 1.5 };
  const notes = migrate(values, 1);

  assert.equal(values.lyricsOffset, 0);
  assert.equal(values.configVersion, CONFIG_VERSION);
  assert.equal(notes.length, 1);
});

test('migration leaves a deliberately chosen offset alone', () => {
  const values = { ...DEFAULTS, lyricsOffset: 3 };
  const notes = migrate(values, 1);

  assert.equal(values.lyricsOffset, 3, 'eine bewusste Einstellung darf nicht überschrieben werden');
  assert.equal(values.configVersion, CONFIG_VERSION);
  assert.equal(notes.length, 0);
});

test('migration is a no-op on a current config', () => {
  const values = { ...DEFAULTS, lyricsOffset: 1.5 };
  const notes = migrate(values, CONFIG_VERSION);

  assert.equal(values.lyricsOffset, 1.5, 'aktuelle Configs werden nicht angefasst');
  assert.equal(notes.length, 0);
});

// ------------------------------------------------------------------- presence

/** Stand-in for DiscordIPC that records what it was asked to send, and when. */
class FakeIpc extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.sent = [];
    this.times = [];
  }
  setActivity(activity) {
    this.sent.push(activity);
    this.times.push(Date.now());
    return true;
  }
}

/** Largest number of sends falling inside any window of `windowMs`. */
function peakPerWindow(times, windowMs) {
  let peak = 0;
  for (const end of times) {
    const count = times.filter((t) => t > end - windowMs && t <= end).length;
    peak = Math.max(peak, count);
  }
  return peak;
}

test('PresenceController coalesces rapid updates into one send', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc);

  for (let i = 0; i < 10; i++) {
    presence.set({ type: 3, details: `Titel ${i}`, state: 'x' });
  }

  await sleep(30);
  assert.equal(ipc.sent.length, 1, 'nur ein Frame darf rausgehen');
  assert.equal(ipc.sent[0].details, 'Titel 9', 'und zwar der neueste');

  presence.stop();
});

test('PresenceController stops sending once the window is exhausted', async () => {
  const ipc = new FakeIpc();
  // Tiny window so the test stays fast; the ratio is what matters.
  const presence = new PresenceController(ipc, { limit: 3, windowMs: 5000 });

  for (let i = 0; i < 6; i++) {
    presence.set({ type: 3, details: `Titel ${i}`, state: 'x' });
    await sleep(15);
  }

  assert.equal(ipc.sent.length, 3, 'das Limit muss halten');
  presence.stop();
});

test('PresenceController ignores sub-second timestamp drift', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc);
  const start = Date.now();

  presence.set({ type: 3, details: 'Song', state: 'x', timestamps: { start } });
  await sleep(20);
  // Same activity, start recomputed a few hundred ms later — must not re-send.
  presence.set({ type: 3, details: 'Song', state: 'x', timestamps: { start: start + 400 } });
  await sleep(20);

  assert.equal(ipc.sent.length, 1);

  // A real seek, however, must get through.
  presence.set({ type: 3, details: 'Song', state: 'x', timestamps: { start: start + 30000 } });
  await sleep(20);
  assert.equal(ipc.sent.length, 2);

  presence.stop();
});

test('PresenceController waits for a near line boundary instead of sending stale content', async () => {
  const ipc = new FakeIpc();
  // step = 400/5 = 80 ms, so the "defer" threshold is 40 ms.
  const presence = new PresenceController(ipc, { limit: 5, windowMs: 400 });

  // A boundary 20 ms out is inside the threshold: waiting for it means landing
  // exactly on the new line rather than sending one that is about to be wrong.
  presence.setNextChangeAt(Date.now() + 20);
  presence.set({ type: 3, details: 'Song', state: '♪ alte Zeile' });

  await sleep(5);
  assert.equal(ipc.sent.length, 0, 'darf nicht sofort senden');

  await sleep(40);
  assert.equal(ipc.sent.length, 1, 'muss an der Grenze senden');

  presence.stop();
});

test('PresenceController does not wait for a distant boundary', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc, { limit: 5, windowMs: 400 });

  // 200 ms out, far beyond step/2 — waiting would leave the profile wrong for
  // longer than sending now does.
  presence.setNextChangeAt(Date.now() + 200);
  presence.set({ type: 3, details: 'Song', state: '♪ Zeile' });

  await sleep(25);
  assert.equal(ipc.sent.length, 1, 'muss sofort senden');

  presence.stop();
});

test('PresenceController pulls fresh content at send time', async () => {
  const ipc = new FakeIpc();
  let currentLine = 'Zeile A';
  const presence = new PresenceController(ipc, {
    limit: 1,
    windowMs: 120,
    provider: () => ({ type: 3, details: 'Song', state: `♪ ${currentLine}` }),
  });

  // Burn the only slot, so the next send has to wait.
  presence.set({ type: 3, details: 'Song', state: '♪ Zeile A' });
  await sleep(20);
  assert.equal(ipc.sent.length, 1);

  // Change is noticed now, but cannot go out yet…
  currentLine = 'Zeile B';
  presence.set({ type: 3, details: 'Song', state: '♪ Zeile B' });
  // …and by the time a slot opens, the song has moved on again.
  await sleep(40);
  currentLine = 'Zeile C';

  await sleep(120);
  assert.equal(ipc.sent.length, 2);
  assert.equal(
    ipc.sent[1].state,
    '♪ Zeile C',
    'gesendet werden muss die Zeile, die beim Senden gilt — nicht die von vorhin',
  );

  presence.stop();
});

test('PresenceController lets an urgent change jump a pending deferral', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc, { limit: 5, windowMs: 400 });

  presence.setNextChangeAt(Date.now() + 35);
  presence.set({ type: 3, details: 'Alter Song', state: '♪ x' });
  await sleep(5);
  assert.equal(ipc.sent.length, 0, 'wartet auf die Grenze');

  // A track change must not sit behind a lyric boundary.
  presence.setNextChangeAt(null);
  presence.set({ type: 3, details: 'Neuer Song', state: '♪ y' }, { urgent: true });

  await sleep(10);
  assert.equal(ipc.sent.length, 1);
  assert.equal(ipc.sent[0].details, 'Neuer Song');

  presence.stop();
});

test('PresenceController never exceeds the limit, boundaries or not', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc, { limit: 3, windowMs: 300 });

  // Hammer it with boundary hints at every step; the budget must still hold.
  for (let i = 0; i < 12; i++) {
    presence.setNextChangeAt(Date.now() + 10);
    presence.set({ type: 3, details: 'Song', state: `♪ Zeile ${i}` });
    await sleep(20);
  }

  // The invariant is the SLIDING window, not the total: over a run longer than
  // the window, earlier sends legitimately age out and free the budget again.
  const peak = peakPerWindow(ipc.times, 300);
  assert.ok(peak <= 3, `Limit verletzt: ${peak} Sendungen in einem 300-ms-Fenster`);
  assert.ok(ipc.sent.length >= 3, 'das Budget soll auch genutzt werden');

  presence.stop();
});

test('PresenceController re-sends after a reconnect', async () => {
  const ipc = new FakeIpc();
  const presence = new PresenceController(ipc);

  presence.set({ type: 3, details: 'Song', state: 'x' });
  await sleep(20);
  assert.equal(ipc.sent.length, 1);

  // Discord forgets the activity on reconnect, so the same payload must go out
  // again even though nothing about it changed.
  ipc.emit('disconnected', { reason: 'test' });
  ipc.emit('connected', { user: null });
  await sleep(20);

  assert.equal(ipc.sent.length, 2);
  presence.stop();
});

// -------------------------------------------------------------------- session

test('Session interpolates the position between reports', async () => {
  const session = new Session();
  session.update({ ...BASE_STATE, position: 30 });

  assert.ok(Math.abs(session.position - 30) < 0.1);
  await sleep(120);
  assert.ok(session.position > 30.05, 'Position muss weiterlaufen');
  assert.ok(session.position < 31, 'aber nicht springen');
});

test('Session freezes the position while paused', async () => {
  const session = new Session();
  session.update({ ...BASE_STATE, position: 30, paused: true });

  await sleep(80);
  assert.equal(session.position, 30);
});

test('Session never reports past the duration', () => {
  const session = new Session();
  session.update({ ...BASE_STATE, position: 212.9, duration: 213 });

  assert.ok(session.position <= 213);
});

test('Session flags track changes, pauses and seeks', () => {
  const session = new Session();

  assert.equal(session.update({ ...BASE_STATE }).trackChanged, true);
  assert.equal(session.update({ ...BASE_STATE, position: 31 }).trackChanged, false);
  assert.equal(session.update({ ...BASE_STATE, position: 31, paused: true }).pausedChanged, true);
  assert.equal(session.update({ ...BASE_STATE, position: 120 }).seeked, true);
  assert.equal(session.update({ ...BASE_STATE, videoId: 'other' }).trackChanged, true);
});

test('Session distinguishes "cannot do captions" from "captions are off"', () => {
  const session = new Session();

  // Pre-1.1.0 content script: the key is absent entirely.
  const { caption, ...withoutCaption } = { ...BASE_STATE, caption: '' };
  void caption;
  session.update(withoutCaption);
  assert.equal(session.raw.captionCapable, false, 'fehlender Schlüssel = kann nicht');

  // Current content script, subtitles switched off in the player.
  session.update({ ...BASE_STATE, caption: '' });
  assert.equal(session.raw.captionCapable, true, 'leerer String = kann, aber aus');
  assert.equal(session.raw.caption, '');

  // Current content script with a subtitle on screen.
  session.update({ ...BASE_STATE, caption: 'KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU' });
  assert.equal(session.raw.captionCapable, true);
  assert.equal(session.raw.caption, 'KIEDYŚ SIĘ PRZEKRĘCĘ OD ZATORU');
});

test('Session goes stale when reports stop arriving', () => {
  const session = new Session();
  session.update({ ...BASE_STATE });

  assert.equal(session.isStale(), false);
  assert.equal(session.isStale(-1), true); // as if 0 ms were the limit
});

// ----------------------------------------------------------------- thumbnails

test('upscaleGoogleArt raises the requested cover size', () => {
  assert.equal(
    upscaleGoogleArt('https://lh3.googleusercontent.com/abc=w60-h60-l90-rj'),
    'https://lh3.googleusercontent.com/abc=w544-h544-l90-rj',
  );
});

test('upscaleGoogleArt leaves foreign hosts alone', () => {
  assert.equal(upscaleGoogleArt('https://example.com/cover.jpg'), 'https://example.com/cover.jpg');
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
