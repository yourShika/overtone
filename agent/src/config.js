'use strict';

/**
 * Configuration store.
 *
 * Plain JSON in Electron's userData directory. Writes are atomic (temp file +
 * rename) because the settings window and the tray menu can both save, and a
 * half-written config would brick the next start.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

/**
 * Browsers yt-dlp can read a YouTube session from.
 *
 * A closed list rather than free text: the value goes straight onto a command
 * line, and these are the names yt-dlp itself accepts.
 */
const BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'vivaldi'];

/**
 * Bumped whenever an existing config needs adjusting rather than merely
 * gaining new keys. New keys need no migration — they fall back to their
 * default automatically — but a *changed* default does, because the stored file
 * would otherwise keep the old value forever.
 */
const CONFIG_VERSION = 2;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,

  /**
   * Discord application id. The application's NAME is what Discord prints as
   * the activity header ("Watching <name>"), so call it "YouTube" in the
   * developer portal if that is the look you want.
   */
  clientId: '',

  /** Local bridge the browser extension connects to. */
  port: 8787,

  enabled: true,

  // --- presentation ---------------------------------------------------------
  /** 'auto' | 'playing' | 'listening' | 'watching' */
  activityType: 'auto',
  /**
   * Template for the activity header — the "Hört <name> zu" line.
   *
   * Empty keeps Discord's own behaviour: the application name from the
   * developer portal, identical for every song. Placeholders: {artist},
   * {title}, {channel}. Multi-artist strings are normalised to the comma form
   * ("doli x szevczor" -> "doli, szevczor").
   */
  activityName: '{artist} - {title}',
  /**
   * Strip the noise YouTube titles carry — "(Official Music Video)", "[HD]",
   * "(Lyrics)" and the like — from what is displayed.
   *
   * Only clearly decorative parts go. Brackets that carry meaning stay, so
   * "(Live at Wembley)", "(Remastered 2011)" and "(prod. …)" survive: dropping
   * those would change which recording you appear to be listening to.
   */
  cleanTitles: true,
  showTimestamps: true,
  showButton: true,
  buttonLabel: '',
  showChannelButton: false,
  /** Empty means the translated default is used. */
  channelButtonLabel: '',
  hideWhenPaused: false,
  /**
   * Show a small badge on the artwork for playing, paused, looping or live.
   *
   * Served from the project repository, because Discord proxies external asset
   * URLs — which spares every user from uploading art assets to their own
   * application before the badges work.
   */
  showStateBadge: true,
  stateIconBase: 'https://raw.githubusercontent.com/yourShika/overtone/main/docs/img/state',
  /**
   * Keep a presence while a YouTube tab is open but nothing is playing.
   *
   * Only ever from a visible tab, so a forgotten background tab cannot claim
   * the profile indefinitely.
   */
  showWhenBrowsing: true,
  /**
   * Let the extension reload a YouTube tab whose player has wedged.
   *
   * Lives here rather than only in the browser because the switch belongs next
   * to the other behaviour switches, and the agent is the only thing that can
   * put it there. It reaches the extension through the status broadcast, which
   * writes it into chrome.storage, where the content script has always read it.
   */
  watchdogEnabled: true,
  /** Suppress titles/artwork but keep "is watching something" visible. */
  privacyMode: false,

  /**
   * Optional asset keys uploaded under Rich Presence > Art Assets in the
   * developer portal. Only used as fallbacks / for the small corner icon.
   */
  fallbackAssetKey: '',
  sourceAssetKey: '',
  pausedAssetKey: '',

  /** Prefer maxresdefault artwork (HEAD-checked) over the always-present hq. */
  highResArtwork: true,

  // --- lyrics ---------------------------------------------------------------
  lyricsEnabled: true,
  /**
   * Where the lyric line comes from.
   *   'auto'     — LRCLIB when it has the song, YouTube subtitles otherwise
   *   'lrclib'   — database only
   *   'captions' — YouTube subtitles only (needs subtitles switched on in the player)
   *
   * Subtitles cover songs no database has and are already in sync, but cannot
   * be read ahead — so LRCLIB wins when available, because its lookahead can
   * compensate for Discord's update limit.
   */
  lyricsSource: 'auto',
  /** Only run lyrics on music.youtube.com, not on every video. */
  lyricsMusicOnly: false,
  /**
   * Manual trim in seconds, positive = earlier.
   *
   * Deliberately 0: the scheduler now aligns sends to the line boundaries
   * themselves, so there is no systematic lag left for a fixed lead-in to
   * cancel. A constant offset could only ever fit one point in the rate-limit
   * window and was wrong everywhere else — early here, late there. This remains
   * only for LRC files whose own timestamps are off.
   */
  lyricsOffset: 0,
  /**
   * Put the lyric on the first (bold) line and demote the title to the second.
   * This is as close to "lyrics as your status" as the API legitimately gets.
   */
  lyricsProminent: false,
  /**
   * How the lyric is presented.
   *   'line'  — the current line, merging neighbours per `lyricsCombine`
   *   'block' — a paragraph that stands until its last line has been sung
   *
   * Block mode exists to spend far less of Discord's update budget: one update
   * per paragraph instead of one per line. It reads less like karaoke and more
   * like a lyric sheet, which is a matter of taste, hence the choice.
   */
  lyricsMode: 'line',
  /** Character budget for one block; Discord's own field limit is 128. */
  lyricsMaxChars: 120,
  /**
   * Line mode only: how far ahead one update may gather lines, as a multiple of
   * the interval between updates. 0 disables merging entirely.
   *
   * Discord allows an update roughly every four seconds; a fast track changes
   * lines every two, so without merging half the lyrics never show at all.
   * Nothing is ever shortened — a line only joins if it fits whole.
   *
   * 1 is the principled default: it merges exactly those lines the *next*
   * update could not rescue anyway, so completeness improves at no cost to
   * timing. Higher values catch more lines but put them on screen earlier,
   * which trades away the accuracy the scheduler works for.
   */
  lyricsCombine: 1,
  /**
   * Keep a copy of every fetched lyric in %APPDATA%/Overtone/lyrics as a plain
   * .lrc file, so replaying a song needs no network — and so there is a file to
   * correct when the timing is off. Files you wrote yourself are never
   * overwritten, and always take precedence over anything fetched.
   */
  lyricsSave: true,

  // --- local transcription --------------------------------------------------
  /**
   * Transcribe songs nothing else knows, using yt-dlp and Whisper locally.
   *
   * Off by default: it saturates every CPU core for roughly a third of the
   * song's length, which is not something to start behind someone's back while
   * they might be gaming. The result lands in the library, so it helps the
   * *next* play — never the one that triggered it.
   */
  transcribeEnabled: false,
  /**
   * Language code such as 'pl' or 'de'. Empty lets Whisper detect it.
   *
   * Only worth setting for the smaller models. `small` misidentified a Polish
   * track as Russian and returned Cyrillic nonsense until the language was
   * pinned; `medium` gets it right on its own, which is why it is the default
   * despite being slower.
   */
  transcribeLanguage: '',
  /**
   * tiny | base | small | medium.
   *
   * 'medium' because language detection is what decides whether the output is
   * usable at all, and it is the first size that gets that right on music.
   */
  transcribeModel: 'medium',
  /**
   * Transcribe even when YouTube is already showing subtitles.
   *
   * Off by default, because subtitles are free, instant and often the actual
   * lyrics. Worth turning on when the available track is an auto-generated one
   * that garbles the words, or a translation rather than the sung text.
   */
  transcribeEvenWithCaptions: false,
  /**
   * Skip anything longer than this many minutes.
   *
   * Transcription cost scales with length, so a podcast or a two-hour mix would
   * occupy the queue for an hour and produce something no one wants as a lyric
   * line. 0 disables the limit.
   */
  transcribeMaxMinutes: 7,
  /** Only start after this many seconds of listening, so skipped tracks are ignored. */
  transcribeAfterSeconds: 45,
  pythonPath: 'python',
  ytdlpPath: 'yt-dlp',
  /**
   * Browser whose YouTube session yt-dlp may borrow, or '' for none.
   *
   * Age-restricted videos are not a format problem and no amount of retrying
   * gets past one: YouTube wants to know the viewer is old enough, and the only
   * honest answer is to be signed in. With a browser named here, yt-dlp reads
   * that browser's cookies and asks as you — the same account, the same
   * permission you already have when you press play yourself.
   *
   * Off by default, because it reaches into a cookie store that holds far more
   * than YouTube. Nothing is copied anywhere: yt-dlp reads it, uses it for the
   * one request, and the session never leaves the machine.
   */
  cookiesFromBrowser: '',
  /**
   * Path to a Netscape cookies.txt, used in preference to the browser above.
   *
   * Exists because reading a browser directly does not work on Windows while
   * that browser is running: Chromium opens its cookie database with no sharing
   * at all, so even a read fails — and the browser you watch YouTube in is
   * running by definition. A file exported once has no such problem. It ages,
   * which is the trade, but it is the only route that works without closing the
   * thing you are watching in.
   */
  cookiesFile: '',
  /**
   * JavaScript runtime yt-dlp uses to solve YouTube's challenge.
   *
   * Required, not cosmetic: without one the embedded player client offers no
   * audio-only format and the download fails with "Requested format is not
   * available", which looks like a format problem and is not. Set empty only if
   * yt-dlp is configured with a runtime of its own.
   */
  ytdlpJsRuntime: 'node',

  // --- system ---------------------------------------------------------------
  /**
   * Interface language, applied to everything the program shows — including the
   * text that lands on your Discord profile.
   *
   * English by default rather than the system language: the profile text is
   * read by other people, and English is the safest thing for them to meet.
   * 'sys' follows the operating system instead.
   */
  language: 'en',
  /** 'dark' | 'light' | 'sys' — 'sys' follows the operating system. */
  theme: 'dark',
  autoStart: false,
  startMinimised: true,
};

class Config extends EventEmitter {
  /** @param {string} filePath */
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.values = { ...DEFAULTS };
    /** @type {string[]} notes from any migration applied on load */
    this.migrations = [];
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge over defaults so a config written by an older version still boots
      // once new keys are introduced.
      this.values = { ...DEFAULTS, ...sanitise(parsed) };

      const notes = migrate(this.values, parsed.configVersion ?? 1);
      if (notes.length) {
        this.migrations = notes;
        this.save();
      }
    } catch {
      this.values = { ...DEFAULTS };
      // Materialise the file on first run. The docs point users at this path,
      // and "the file does not exist" is a confusing answer when they look.
      this.save();
    }
    return this.values;
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /**
   * @param {object} patch
   * @returns {string[]} keys that actually changed
   */
  set(patch) {
    const clean = sanitise(patch);
    const changed = [];

    for (const [key, value] of Object.entries(clean)) {
      if (!(key in DEFAULTS)) continue;
      if (this.values[key] === value) continue;
      this.values[key] = value;
      changed.push(key);
    }

    if (changed.length) {
      this.save();
      this.emit('changed', changed, this.all());
    }
    return changed;
  }

  save() {
    const temp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(this.values, null, 2), 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch (err) {
      this.emit('error', err);
    }
  }

  reset() {
    this.values = { ...DEFAULTS };
    this.save();
    this.emit('changed', Object.keys(DEFAULTS), this.all());
  }
}

/**
 * Bring a stored config up to the current version, in place.
 *
 * @param {object} values merged config, modified in place
 * @param {number} from the version the file was written with
 * @returns {string[]} human-readable notes, empty when nothing changed
 */
function migrate(values, from) {
  const notes = [];
  if (from >= CONFIG_VERSION) return notes;

  if (from < 2) {
    // v1 shipped a 1.5 s lead-in, because sends went out whenever the rate
    // limiter opened and were therefore late on average. The scheduler now
    // aligns them to the lyric boundaries themselves, so that lead-in only
    // makes lines appear early. Reset it — but leave a value the user chose
    // deliberately alone, which we approximate by touching only the old default.
    if (values.lyricsOffset === 1.5) {
      values.lyricsOffset = 0;
      // A key rather than a sentence: migration runs while the config is still
      // being loaded, which is before the chosen language is in effect.
      notes.push('msg.migrateLyricsOffset');
    }
  }

  values.configVersion = CONFIG_VERSION;
  return notes;
}

/** Coerce incoming values to the type of their default; drop unknown keys. */
function sanitise(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};

  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULTS)) continue;
    const fallback = DEFAULTS[key];

    if (typeof fallback === 'boolean') {
      out[key] = Boolean(value);
    } else if (typeof fallback === 'number') {
      const parsed = Number(value);
      out[key] = Number.isFinite(parsed) ? parsed : fallback;
    } else {
      out[key] = typeof value === 'string' ? value.trim() : fallback;
    }
  }

  if (out.port !== undefined) {
    out.port = Math.min(65535, Math.max(1024, Math.round(out.port)));
  }
  if (out.lyricsOffset !== undefined) {
    out.lyricsOffset = Math.min(10, Math.max(-10, out.lyricsOffset));
  }
  if (out.lyricsCombine !== undefined) {
    out.lyricsCombine = Math.min(3, Math.max(0, out.lyricsCombine));
  }
  // The field's min/max only drive the stepper — a typed 9999 arrives intact,
  // and a wait longer than any song means nothing is ever transcribed while
  // the window keeps showing "waiting for …", which reads like a hang.
  // Straight onto a command line, so it is a choice from a list rather than
  // free text. An unknown name would become an argument yt-dlp cannot read.
  if (out.cookiesFile !== undefined) {
    out.cookiesFile = typeof out.cookiesFile === 'string' ? out.cookiesFile.trim() : '';
  }

  if (out.cookiesFromBrowser !== undefined) {
    out.cookiesFromBrowser = BROWSERS.includes(out.cookiesFromBrowser)
      ? out.cookiesFromBrowser
      : '';
  }

  if (out.transcribeAfterSeconds !== undefined) {
    out.transcribeAfterSeconds = Math.min(300, Math.max(0, Math.round(out.transcribeAfterSeconds)));
  }
  if (out.clientId !== undefined) {
    // Snowflakes are digits only; strip anything a copy-paste dragged along.
    out.clientId = out.clientId.replace(/\D/g, '');
  }

  return out;
}

module.exports = { Config, DEFAULTS, CONFIG_VERSION, migrate, BROWSERS };
