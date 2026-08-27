'use strict';

/**
 * Overtone agent — Electron main process.
 *
 * Wiring:
 *   browser extension --ws--> Bridge --> Session
 *                                          |
 *                          LyricsProvider  v  ThumbnailResolver
 *                                   \  buildActivity  /
 *                                          |
 *                              PresenceController (rate limited)
 *                                          |
 *                                   DiscordIPC --> Discord
 *
 * The tick loop runs at 1 Hz and always recomputes the *desired* activity. The
 * presence controller decides what actually reaches Discord, so ticking often
 * costs nothing and keeps the lyric line as fresh as the rate limit permits.
 */

const path = require('node:path');
const { app, Tray, Menu, BrowserWindow, ipcMain, shell, nativeImage, dialog } = require('electron');

const { Config } = require('./config');
const { t, setLocale, getLocale, detect, dictionary, LANGUAGES } = require('./i18n');
const { Logger } = require('./log');
const { Bridge } = require('./bridge');
const { Session } = require('./session');
const { RestartWatch } = require('./restart-watch');
const { DiscordIPC } = require('./discord/ipc');
const { PresenceController } = require('./discord/presence');
const { buildActivity } = require('./discord/activity');
const { LyricsProvider } = require('./lyrics/lrclib');
const { LyricsLibrary } = require('./lyrics/library');
const { Transcriber } = require('./lyrics/transcriber');
const { lyricWindow, buildBlocks, blockAt } = require('./lyrics/lrc');
const { parseTrack } = require('./lyrics/trackparse');
const { ThumbnailResolver, youtubeThumb } = require('./thumbnails');
const { PluginRegistry } = require('./plugins/registry');
const { PluginStore } = require('./plugins/store');
const { SurfaceServer } = require('./plugins/surface');
const { overlayPayload } = require('./plugins/feed');

const TICK_MS = 1000;
const ASSETS = path.join(__dirname, '..', 'assets');

// A second instance would fight over the bridge port and the Discord socket.
// The running instance gets a 'second-instance' event and raises its settings
// window; this copy leaves immediately.
//
// app.exit() rather than app.quit(): before 'ready', quit() runs the shutdown
// sequence and is not reliably immediate on Windows, which can leave a stuck
// process holding nothing but confusing the next launch.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  return;
}

app.setAppUserModelId('com.overtone.agent');

/** @type {Tray|null} */
let tray = null;
/** @type {BrowserWindow|null} */
let settingsWindow = null;
/** @type {BrowserWindow|null} */
let trayWindow = null;
/** @type {BrowserWindow|null} */
let wizardWindow = null;

let config;
let logger;
let bridge;
let discord;
let presence;
let lyrics;
let library;
let transcriber;
let thumbnails;
let plugins;
let pluginStore;
let surface;

const session = new Session();

/** Notices a player that keeps restarting the same video — see restart-watch.js. */
const restartWatch = new RestartWatch();
let tickTimer = null;

/** Lyrics state for the currently playing track. */
const lyricState = {
  trackId: null,
  lines: null,
  status: 'idle', // idle | loading | found | none | captions | disabled
  current: null,
  // Where the line ON SCREEN came from. Null whenever nothing is shown —
  // paused, lyrics off, music-only mismatch — even though lines may be loaded.
  origin: null, // 'library' | 'lrclib' | 'captions' | 'transcribing'
  // Which of the two database sources filled `lines`. Only meaningful while
  // status is 'found'; the two are always written together.
  fromLibrary: false,
  // Whether that library file is one Overtone wrote or one the user did. Both
  // arrive through the same door; only the marker in the file tells them apart,
  // and calling a cached download "your file" would be a plain lie.
  libraryManaged: false,
  nextTime: null, // track seconds; cue of the first line not yet shown
  merged: 1, // how many lyric lines the current text carries
  blocks: null, // packed paragraphs, built lazily in block mode
};

let lastError = null;

/** What the connected browser extension told us it can do. */
const extension = { version: null, features: [] };

/**
 * Where the transcription worker lives.
 *
 * Packaged, the app source sits inside app.asar, which Python cannot read into
 * — so the script ships beside the archive as an extra resource instead. From
 * source it is simply the repo's tools directory.
 */
/**
 * Example plugins that travel with the app but are not installed by it.
 *
 * Nothing here is loaded. A plugin becomes real by being copied into the user's
 * own folder, on purpose, once — after which it is theirs to edit or delete,
 * and an update will not put it back or overwrite what they changed.
 *
 * Packaged, they sit beside the asar rather than inside it: a surface's files
 * are served to a browser, and reading them out of an archive on every request
 * would be pointless work.
 */
/**
 * Open the surface server on the address it had last time.
 *
 * The token is minted once and then kept, because an address pasted into an OBS
 * scene has to survive quitting the app — a new one every morning is a broken
 * source with no visible cause.
 */
async function startSurface() {
  await surface.sync(config.get('pluginSurfacePort'), config.get('surfaceToken'));
  if (surface.running && surface.token !== config.get('surfaceToken')) {
    config.set({ surfaceToken: surface.token });
  }
}

function examplesPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'examples')
    : path.join(__dirname, '..', '..', 'plugins');
}

function transcribeScriptPath() {
  const name = 'transcribe-to-lrc.py';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tools', name)
    : path.join(__dirname, '..', '..', 'tools', name);
}

// ---------------------------------------------------------------------- boot

app.whenReady().then(async () => {
  const userData = app.getPath('userData');

  config = new Config(path.join(userData, 'config.json'));
  applyLanguage();
  logger = new Logger({
    filePath: path.join(userData, 'logs', 'overtone.log'),
    level: process.argv.includes('--verbose') ? 'debug' : 'info',
    onEntry: (entry) => sendToSettings('log:entry', entry),
  });

  logger.info(t('msg.starting', { version: app.getVersion() }));
  for (const note of config.migrations) logger.info(t('msg.settingAdjusted', { note: t(note) }));

  thumbnails = new ThumbnailResolver({ logger });
  library = new LyricsLibrary({
    directory: path.join(userData, 'lyrics'),
    logger,
    // The recycle bin, not fs.rm. A file you corrected by hand is the only
    // thing in this folder nothing can fetch again, so the delete a person can
    // reach from the window has to be one they can walk back.
    trash: (file) => shell.trashItem(file),
  });
  library.ensureDirectory().catch(() => {});

  transcriber = new Transcriber({
    workDir: path.join(app.getPath('temp'), 'overtone-transcribe'),
    libraryDir: path.join(userData, 'lyrics'),
    script: transcribeScriptPath(),
    logger,
  });
  if (!require('node:fs').existsSync(transcriber.script)) {
    logger.warn(
      t('msg.trScriptMissing', { path: transcriber.script }),
    );
  }

  // The .lrc only exists once the job finishes, so re-run the lookup then.
  transcriber.on('done', () => {
    lyricState.trackId = null;
    refreshUi();
  });
  transcriber.on('change', refreshUi);

  pluginStore = new PluginStore(path.join(userData, 'plugins.json'), logger);
  plugins = new PluginRegistry({
    userDir: path.join(userData, 'plugins'),
    store: pluginStore,
    logger,
  });
  await plugins.scan();
  for (const found of plugins.describe(getLocale())) {
    if (found.problem) logger.warn(t('msg.plugBroken', { id: found.id, reason: found.problem }));
    else logger.debug(t('msg.plugFound', { id: found.id }));
  }

  surface = new SurfaceServer({
    registry: plugins,
    payload: (id) => ({
      ...overlayPayload({
        snapshot: statusSnapshot(),
        config: config.all(),
        lines: lyricState.lines,
        now: Date.now(),
      }),
      // The plugin's own settings ride with the song rather than in the URL, so
      // one pasted address keeps working and moving a slider reaches a running
      // Browser Source instead of waiting to be pasted again.
      settings: plugins.describe('en').find((p) => p.id === id)?.values || {},
    }),
    logger,
  });
  await startSurface();

  lyrics = new LyricsProvider({
    cacheDir: path.join(userData, 'lyrics-cache'),
    userAgent: `Overtone/${app.getVersion()} (https://github.com/overtone-app/overtone)`,
    logger,
  });

  setupDiscord();
  await setupBridge();
  setupTray();
  registerIpc();

  config.on('changed', onConfigChanged);
  applyAutoStart();

  tickTimer = setInterval(tick, TICK_MS);

  // Nothing configured yet means a first run: the wizard explains the parts in
  // order, where the settings window would just present every option at once.
  if (!config.get('clientId')) {
    logger.info(t('msg.notSetUp'));
    openWizard();
  }
});

// Electron quits when the last window closes *unless* something listens here.
// A tray app spends most of its life without any window, so we listen and do
// nothing on purpose.
/**
 * Last resort, and it exists because there was none.
 *
 * A throw from a timer or a socket callback has nothing above it, so Electron
 * would take the tray agent down without a word — the presence simply stops and
 * the log ends mid-sentence. Logging it and staying up is the better failure:
 * whatever threw is one feature, and the rest of the app still works.
 */
process.on('uncaughtException', (err) => {
  logger?.error?.(`${err?.message || err}\n${err?.stack || ''}`);
});
process.on('unhandledRejection', (reason) => {
  logger?.error?.(String(reason?.stack || reason));
});

app.on('window-all-closed', () => {});

app.on('second-instance', () => openSettings());

app.on('before-quit', async () => {
  clearInterval(tickTimer);
  presence?.stop();
  try {
    discord?.clearActivity();
  } catch {
    /* connection already gone */
  }
  discord?.destroy();
  await surface?.stop();
  await bridge?.stop();
  logger?.close();
});

// ------------------------------------------------------------------- discord

function setupDiscord() {
  discord = new DiscordIPC(config.get('clientId'));

  discord.on('connected', ({ user }) => {
    lastError = null;
    const tag = user?.username ? `@${user.username}` : '?';
    logger.info(t('msg.discordConnected', { user: tag }));
    refreshUi();
  });

  discord.on('disconnected', ({ reason }) => {
    logger.warn(t('msg.discordLost', { reason }));
    refreshUi();
  });

  discord.on('retry', ({ reason, delay }) => {
    logger.debug(t('msg.discordRetry', { seconds: Math.round(delay / 1000), reason }));
  });

  discord.on('error', (err) => {
    lastError = err.message;
    logger.error(t('msg.discordError', { error: err.message }));
    refreshUi();
  });

  presence = new PresenceController(discord, {
    // Pulled at the instant a frame is sent, so the lyric line is the one
    // that is current *then* rather than when the tick noticed a change.
    provider: () => {
      if (!config.get('enabled') || !session.active) return null;
      const state = session.state;
      const cfg = config.all();
      if (state.idle) return buildActivity({ state, config: cfg });
      return buildActivity({
        state,
        config: cfg,
        lyric: currentLyricLine(state, cfg),
        image: latestImage,
      });
    },
    onSend: (activity) => {
      logger.debug(t('msg.presenceSent', { details: activity ? activity.details : t('msg.presenceCleared') }));
      refreshUi();
    },
  });

  discord.connect();
}

// -------------------------------------------------------------------- bridge

async function setupBridge() {
  bridge = new Bridge({ port: config.get('port'), logger });

  // The extension reloads a wedged YouTube tab by itself; say so, because a
  // page vanishing without explanation is alarming rather than reassuring.
  bridge.on('watchdog', (type, payload) => {
    if (type === 'watchdog:reloading') {
      logger.warn(
        t('msg.watchdogReloading', {
          title: payload.title || payload.videoId,
          readyState: payload.readyState,
          networkState: payload.networkState,
          attempt: payload.attempt,
        }),
      );
    } else {
      logger.warn(t('msg.watchdogGaveUp', { attempts: payload.attempts }));
    }
    refreshUi();
  });

  bridge.on('state', (payload) => {
    if (!config.get('enabled')) return;

    const change = session.update(payload);
    reportFault(payload);

    if (change.trackChanged) {
      // Ask the session, not the wire: payload.title is YouTube's raw string, so
      // the log announced "… (Official Video)" while the presence, the tray and
      // the settings preview all showed the cleaned title.
      logger.info(t('msg.nowPlaying', { title: trackLabel() }));
      restartWatch.settled(session.raw?.videoId);
      resetLyrics();

      // Warn once per track rather than once per report, so the log stays
      // readable while still being impossible to miss.
      if (!session.raw.captionCapable && config.get('lyricsSource') !== 'lrclib') {
        logger.warn(t('msg.extensionOutdated'));
      }
    } else if (change.resumed) {
      // Invisible at the default level, but with --verbose it turns "why is this
      // song announced four times" into one line that says what happened.
      logger.debug(t('msg.trackResumed', { title: trackLabel() }));

      // Three times over is no longer a flaky connection. Say what it means
      // rather than leaving the pattern for someone to count by eye.
      if (restartWatch.resumed(session.raw?.videoId)) {
        logger.warn(t('msg.playerRestarting', { title: trackLabel() }));
      }
    }
    // These must not sit behind a lyric-boundary deferral: showing the previous
    // song for a few extra seconds is far worse than a slightly early lyric.
    if (change.trackChanged || change.pausedChanged || change.seeked) {
      presence.setNextChangeAt(null);
      urgentTick = true;
      tick();
    }
  });

  bridge.on('clear', (payload) => {
    if (!session.active && !session.raw) return;
    logger.debug(t('msg.playbackEnded', { reason: payload?.reason || '?' }));
    session.clear();
    resetLyrics();
    presence.clear();
    refreshUi();
  });

  bridge.on('hello', (payload, socket) => {
    extension.version = payload.version || null;
    extension.features = Array.isArray(payload.features) ? payload.features : [];

    logger.info(
      t('msg.extensionConnected', {
        name: payload.client || '?',
        version: extension.version || '?',
      }) + (extension.features.length ? ` [${extension.features.join(', ')}]` : ''),
    );

    // The features list says what this build can do; the version says whether
    // it is the build that shipped with this agent. Both are needed: an
    // unpacked copy keeps running until it is reloaded by hand, so updating the
    // app alone leaves an old bridge in the browser saying nothing is wrong.
    if (extension.version && extension.version !== app.getVersion()) {
      logger.warn(
        t('msg.extensionVersionMismatch', {
          extension: extension.version,
          app: app.getVersion(),
        }),
      );
    }

    socket.send(JSON.stringify({ type: 'status', payload: statusSnapshot() }));
    refreshUi();
  });

  bridge.on('command', (name) => {
    if (name === 'openSettings') openSettings();
    if (name === 'toggleEnabled') setEnabled(!config.get('enabled'));
  });

  bridge.on('clients', (count) => {
    if (!count) {
      extension.version = null;
      extension.features = [];
    }
    refreshUi();
  });

  try {
    await bridge.start();
  } catch (err) {
    logger.error(t('msg.bridgeFailed', { error: err.message }));
    dialog.showErrorBox(
      t('msg.portTakenTitle'),
      `${t('msg.portTaken', { port: config.get('port') })}\n\n${t('msg.portInUse')}`,
    );
  }
}

// ---------------------------------------------------------------- tick / core

/**
 * Reentrancy guard. A cold thumbnail probe can outlast the 1 s interval, and
 * two overlapping ticks could then finish out of order — leaving the older
 * one's activity as the final word. Skipping is safe: the next tick is 1 s away
 * and recomputes everything from scratch anyway.
 */
let ticking = false;

/** Last resolved artwork URL, cached so the provider can stay synchronous. */
let latestImage = null;

/** Set when the next tick carries a change that must not be deferred. */
let urgentTick = false;

/**
 * Tracks that have been part-listened and may still earn a transcription.
 *
 * A single slot used to hold one of these, so changing songs threw away
 * whatever listening time the last one had collected — the complaint this map
 * answers. Keyed by video id, it outlives track changes: a song you keep
 * coming back to keeps its credit, and a song you skimmed for three seconds
 * simply never reaches the threshold, which is what the playlist gate in
 * noteTranscribeCandidate() was always for.
 * @type {Map<string, {videoId: string, url: string, artist: string,
 *   track: string, watched: number, position: number, at: number,
 *   ripe: boolean, held: boolean}>}
 */
const watching = new Map();

/**
 * How many part-listened tracks to remember at once.
 *
 * Only a track whose lyric lookup came back empty ever lands here, so this
 * fills slowly; the cap is there so a night of unknown songs cannot grow it
 * without end. When it is reached the least-listened entry goes — that is the
 * one the least is invested in.
 */
const MAX_WATCHING = 12;

/**
 * Video id the listening clock is anchored to, or null while browsing.
 *
 * The anchor has to be re-set whenever attention moved elsewhere, or the first
 * tick back on a track would credit the whole gap at once.
 */
let creditingId = null;

/** Last track whose length we already complained about, to log it once. */
let transcribeSkipNoted = null;

/** Last logged player fault, so a stuck tab does not fill the log. */
let faultNoted = null;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await runTick();
  } finally {
    ticking = false;
  }
}

async function runTick() {
  const cfg = config.all();
  if (!cfg.enabled) {
    presence.clear();
    // Stop the listening clock with it. Leaving the anchor set means the first
    // tick after switching back on books the whole gap as time heard.
    creditingId = null;
    return;
  }

  // Feed the queue first, and deliberately before the early returns below: a
  // track turned away because the queue was full gets its slot the moment one
  // frees up, and nothing else would bring it back — the lyric lookup that
  // first noticed it runs once per track, minutes and several songs ago.
  flushTranscribeQueue(cfg);

  // A snapshot that stopped arriving means the tab or browser is gone.
  if (!session.active) {
    if (session.raw) {
      session.clear();
      resetLyrics();
    }
    presence.clear();
    // Same reason: a paused player stops reporting, the session goes stale, and
    // a later seek would otherwise be credited as listening that never happened.
    creditingId = null;
    return;
  }

  const state = session.state;

  // Credit the listening this tick actually delivered. Above the `idle` branch
  // on purpose, so a track keeps its credit while the tab wanders off to the
  // home page and comes back.
  creditListening(state);

  // Browsing has no track, so none of the per-track machinery applies: no
  // lyrics to look up, no artwork to resolve, nothing to transcribe.
  if (state.idle) {
    if (lyricState.trackId !== null) resetLyrics();
    latestImage = null;
    presence.setNextChangeAt(null);
    presence.set(buildActivity({ state, config: cfg }));
    return;
  }

  const line = currentLyricLine(state, cfg);
  latestImage = await thumbnails.resolve(state, cfg.highResArtwork).catch(() => null);

  // Hand the scheduler the upcoming boundary so it can land the send exactly on
  // the line change instead of whenever the rate limiter next opens.
  presence.setNextChangeAt(nextLyricChangeAt(state, cfg));

  const urgent = urgentTick;
  urgentTick = false;
  presence.set(buildActivity({ state, config: cfg, lyric: line, image: latestImage }), { urgent });

  // Kick off the lookup after building, so the first frame is never delayed by
  // a network round-trip.
  ensureLyricsLoaded(state, cfg);

}

/** Character budget for the lyric, leaving room for the "♪ " prefix. */
const LYRIC_MAX_CHARS = 126;

function currentLyricLine(state, cfg) {
  const view = resolveLyric(state, cfg);
  lyricState.current = view.text;
  lyricState.origin = view.origin;
  lyricState.nextTime = view.nextTime;
  lyricState.merged = view.merged;
  return view.text;
}

/**
 * Decide what the lyric line should say right now, and when it expires.
 *
 * @returns {{ text: string|null, origin: string|null, nextTime: number|null,
 *             merged: number }} `nextTime` is in track seconds — the cue of the
 *   first line NOT yet shown, which is what the scheduler must aim at.
 */
function resolveLyric(state, cfg) {
  const none = { text: null, origin: null, nextTime: null, merged: 1 };

  if (!cfg.lyricsEnabled) return none;
  if (cfg.lyricsMusicOnly && state.source !== 'ytmusic') return none;
  if (state.paused) return none;

  const source = cfg.lyricsSource;

  // Database first when it has the song: only there can we read ahead. A gap
  // between lines is deliberate silence, so we do not fall through to captions.
  if (source !== 'captions' && lyricState.lines?.length) {
    // One update must carry everything until the next slot, so that is exactly
    // how far ahead lines may be merged — expressed in track seconds, hence the
    // playback-rate factor.
    if (cfg.lyricsMode === 'block') {
      // Packed once per track: the breaks depend only on the timings, so
      // recomputing them every tick would burn work to reach the same answer.
      if (!lyricState.blocks) {
        lyricState.blocks = buildBlocks(lyricState.lines, { maxChars: cfg.lyricsMaxChars });
      }
      const block = blockAt(lyricState.blocks, state.position, { offset: cfg.lyricsOffset });
      return {
        text: block ? block.text : null,
        origin: lyricState.fromLibrary ? 'library' : 'lrclib',
        nextTime: block && Number.isFinite(block.end) ? block.end : null,
        merged: block ? block.lines : 1,
      };
    }

    const reach = (presence.step / 1000) * (state.playbackRate || 1) * cfg.lyricsCombine;

    const view = lyricWindow(lyricState.lines, state.position, {
      offset: cfg.lyricsOffset,
      windowSeconds: reach,
      maxChars: LYRIC_MAX_CHARS,
    });

    return {
      text: view.text,
      // Report where the lines actually came from; the status window shows this
      // and "LRCLIB" would be a lie for a file the user wrote themselves.
      origin: lyricState.fromLibrary ? 'library' : 'lrclib',
      nextTime: view.nextTime,
      merged: view.text ? view.text.split(' · ').length : 1,
    };
  }

  // Something is being made — say so, rather than leaving the line blank for
  // the minutes a transcription takes.
  if (transcriber?.busyWith && transcriber.busyWith === state.videoId) {
    // Name the phase. "Being made" for minutes on end looks indistinguishable
    // from stuck, and downloading versus transcribing is the useful difference.
    const label =
      transcriber.phase === 'download' ? t('presence.loadingAudio') : t('presence.makingLyrics');
    return { text: label, origin: 'transcribing', nextTime: null, merged: 1 };
  }

  // Subtitles: whatever YouTube is showing this instant. Covers everything the
  // database misses, including auto-generated and auto-translated tracks.
  // Nothing to merge — the next line is unknown until YouTube renders it.
  if (source !== 'lrclib' && state.caption) {
    return { text: state.caption, origin: 'captions', nextTime: null, merged: 1 };
  }

  return none;
}

function ensureLyricsLoaded(state, cfg) {
  if (!cfg.lyricsEnabled) {
    lyricState.status = 'disabled';
    return;
  }
  // Captions-only mode never queries the network.
  if (cfg.lyricsSource === 'captions') {
    lyricState.status = state.caption ? 'captions' : 'none';
    return;
  }
  if (cfg.lyricsMusicOnly && state.source !== 'ytmusic') return;
  if (lyricState.trackId === state.id) return; // already handled this track

  lyricState.trackId = state.id;
  lyricState.status = 'loading';
  lyricState.lines = null;
  // Derived from lines, so it cannot outlive them — a forced re-read after an
  // edit would otherwise keep serving paragraphs packed from the old file.
  lyricState.blocks = null;
  lyricState.current = null;
  refreshUi();

  const parsed = parseTrack(state);
  if (!parsed.track) {
    lyricState.status = 'none';
    return;
  }

  // Your own file wins over everything. It is the only source you can correct,
  // so a deliberate correction must not lose to a fetched result.
  library
    .find({ videoId: state.videoId, artist: parsed.artistFull, track: parsed.track })
    .then((hit) => {
      if (lyricState.trackId !== state.id) return false;
      if (!hit) return false;

      lyricState.lines = hit.lines;
      lyricState.status = 'found';
      lyricState.fromLibrary = true;
      lyricState.libraryManaged = Boolean(hit.managed);
      logger.info(
        t('msg.lyricsFromLibrary', {
          count: hit.lines.length,
          origin: t(hit.managed ? 'msg.libraryStored' : 'msg.librarySelfMade'),
        }),
      );
      refreshUi();
      return true;
    })
    .catch(() => false)
    .then((served) => {
      if (served || lyricState.trackId !== state.id) return;
      fetchLyrics(state, parsed);
    });
}

/** Network lookup, used only when the library has nothing. */
function fetchLyrics(state, parsed) {
  logger.debug(t('msg.lyricsSearch', { artist: parsed.artist, track: parsed.track }));

  lyrics
    .lookup({
      artist: parsed.artist,
      track: parsed.track,
      album: state.album,
      duration: state.duration,
    })
    .then((result) => {
      // A different track may have started while the request was in flight.
      if (lyricState.trackId !== state.id) return;

      if (result?.synced) {
        lyricState.lines = result.lines;
        lyricState.status = 'found';
        lyricState.fromLibrary = false;
        lyricState.libraryManaged = false;
        logger.info(t('msg.lyricsFound', { count: result.lines.length }));

        // Keep a copy, so playing this again works without the network — and
        // gives you a file to correct if the timing is off.
        if (config.get('lyricsSave')) {
          library
            .store({
              videoId: state.videoId,
              artist: parsed.artistFull || parsed.artist,
              track: parsed.track,
              lines: result.lines,
            })
            .then((written) => {
              if (written) logger.debug(t('msg.lyricsSaved'));
            })
            .catch(() => {});
        }
      } else {
        lyricState.lines = null;
        lyricState.status = 'none';
        logger.debug(t('msg.lyricsNone'));
        noteTranscribeCandidate(state, parsed);
      }
      refreshUi();
    })
    .catch((err) => {
      if (lyricState.trackId !== state.id) return;
      lyricState.status = 'none';
      logger.warn(t('msg.lyricsError', { error: err.message }));
    });
}

/**
 * Wall-clock time at which the displayed lyric will change next, or null.
 *
 * Only the database knows the future: subtitles arrive line by line as YouTube
 * renders them, so there is nothing to predict and the scheduler falls back to
 * sending as soon as it may.
 */
function nextLyricChangeAt(state, cfg) {
  if (!cfg.lyricsEnabled || state.paused) return null;
  if (cfg.lyricsSource === 'captions') return null;
  if (lyricState.origin === 'captions' || !lyricState.lines?.length) return null;

  // Deliberately the boundary of the first line NOT already on screen: when
  // several lines were merged into one update, aiming at the next cue would
  // schedule a send for text the profile is showing anyway.
  const boundary = lyricState.nextTime;
  if (boundary === null || boundary === undefined) return null;

  const effective = state.position + cfg.lyricsOffset;
  const rate = state.playbackRate || 1;
  return Date.now() + ((boundary - effective) / rate) * 1000;
}

/**
 * Remember a track as a transcription candidate, once it is genuinely the last
 * option left.
 *
 * Deliberately conservative: a job pins every CPU core for minutes, so nothing
 * starts while subtitles are already supplying a line, and nothing starts until
 * the track has actually been listened to rather than skipped past. This only
 * writes the candidate down — creditListening() decides when it has earned its
 * place and flushTranscribeQueue() hands it over.
 */
function noteTranscribeCandidate(state, parsed) {
  const cfg = config.all();
  if (!cfg.transcribeEnabled || !cfg.lyricsEnabled) return;
  if (cfg.lyricsSource === 'captions') return;
  // Subtitles are free and instant, so they normally make a job pointless — but
  // an auto-generated or translated track is not the sung text, which is
  // exactly when someone would want their own transcription anyway.
  if (state.caption && !cfg.transcribeEvenWithCaptions) return;
  // No `halted` check any more: a run of failures is nearly always a broken
  // setup, and once it is fixed the songs listened to meanwhile should still be
  // there. The transcriber turns them away with 'deferred' until resetFailures()
  // lifts the stop, which is the whole point of keeping them.
  if (!state.videoId || transcriber.attempted.has(state.videoId)) return;

  // Cost scales with length: a two-hour mix would hold the queue for an hour
  // and yield something nobody wants as a lyric line.
  const capMinutes = cfg.transcribeMaxMinutes ?? 0;
  if (capMinutes > 0 && state.duration > capMinutes * 60) {
    if (transcribeSkipNoted !== state.videoId) {
      transcribeSkipNoted = state.videoId;
      logger.info(t('msg.trSkippedLong', { track: parsed.track, minutes: Math.round(state.duration / 60), limit: capMinutes }));
    }
    return;
  }

  // Skipping through a playlist should not queue a job per track — the gate
  // that says so is still here, but it counts listening rather than the seek
  // bar. A track skimmed for three seconds never reaches it however often it
  // comes round, so the flood this guards against still cannot happen; what
  // changed is that the time is kept per track instead of in one slot, so
  // leaving a song no longer throws away what it had already earned. The two
  // only looked opposed while "listened to" was read off `state.position`,
  // which also let dropping into the middle of a song clear the gate outright.
  const existing = watching.get(state.videoId);
  if (existing) {
    // Back for another go. Refresh what the job will need, keep the credit.
    existing.url = state.url;
    existing.artist = parsed.artistFull || parsed.artist;
    existing.track = parsed.track;
    return;
  }

  if (watching.size >= MAX_WATCHING) forgetLeastListened();
  watching.set(state.videoId, {
    videoId: state.videoId,
    url: state.url,
    artist: parsed.artistFull || parsed.artist,
    track: parsed.track,
    // Starts at zero rather than at the current position, for the same reason
    // the credit is measured below: the position says where the song is, not
    // how much of it was heard.
    watched: 0,
    position: state.position,
    at: Date.now(),
    // Whether a subtitle was ever seen on this track. The check above only
    // sees the instant the candidate is written down, which for most songs is
    // the intro — before YouTube has rendered its first cue. Watching for the
    // whole listening window is the only way it can honestly say "subtitles
    // are already supplying this".
    sawCaption: Boolean(state.caption),
    ripe: false,
    held: false,
  });
}

/**
 * Add the listening time this tick really delivered to the current candidate.
 *
 * Measured rather than read off the position, which is the hole the old
 * `position >= after` test left open: a seek would hand a track forty-five
 * seconds of "listening" in a single tick, so dropping into the middle of a
 * song counted as having heard all of it. Pausing, buffering and seeking
 * backwards all credit nothing, because the position does not advance.
 */
function creditListening(state) {
  // Browsing has no track, and coming back from it must not credit the gap.
  const key = state.idle ? null : state.videoId;
  const moved = creditingId !== key;
  creditingId = key;
  if (!key) return;

  const candidate = watching.get(key);
  if (!candidate) return;

  // Before the re-anchor return below, so a subtitle appearing on the very tick
  // attention came back is still recorded.
  if (state.caption) candidate.sawCaption = true;

  const now = Date.now();
  if (moved) {
    // First tick on this track, or the first after coming back to it: the time
    // since the last one was spent elsewhere and the position may have jumped
    // anywhere, so re-anchor without crediting.
    candidate.position = state.position;
    candidate.at = now;
    return;
  }

  const advanced = state.position - candidate.position;
  const elapsed = (now - candidate.at) / 1000;
  // Half a second of slack: the tick is not a metronome and the position is
  // extrapolated, so an exact comparison would shave time off every tick.
  const credited = Math.max(0, Math.min(advanced, elapsed * (state.playbackRate || 1) + 0.5));

  candidate.watched += credited;
  candidate.position = state.position;
  candidate.at = now;

  if (!candidate.ripe && candidate.watched >= (config.get('transcribeAfterSeconds') ?? 45)) {
    candidate.ripe = true;
    refreshUi();
  }
}

/**
 * Hand every candidate that has earned its place to the transcriber.
 *
 * Deliberately not tied to what is playing. The queue has room again only when
 * a job finishes — usually minutes and several songs later — and a track turned
 * away back then has nothing left to trigger a second attempt.
 */
function flushTranscribeQueue(cfg) {
  if (!watching.size) return;
  if (!cfg.transcribeEnabled || !cfg.lyricsEnabled) return;

  for (const candidate of watching.values()) {
    if (!candidate.ripe) continue;

    // Checked here rather than only when the candidate was written down. Most
    // songs are noted during the intro, before YouTube has rendered a single
    // cue, so the guard at that moment saw nothing and let a job through for a
    // track that turned out to carry the lyrics as subtitles all along.
    if (candidate.sawCaption && !cfg.transcribeEvenWithCaptions) {
      watching.delete(candidate.videoId);
      continue;
    }

    const outcome = transcriber.submit({
      videoId: candidate.videoId,
      url: candidate.url,
      artist: candidate.artist,
      track: candidate.track,
      config: cfg,
      // Re-read at start time: a queued job may wait minutes, and the language
      // or model it should use is whatever is set when it actually runs.
      getConfig: () => config.all(),
    });

    if (outcome === 'deferred') {
      // No slot right now, and everything behind it would be turned away for
      // the same reason. Say so once per track: a finished song with no job
      // running and nothing in the log is otherwise unexplainable.
      if (!candidate.held) {
        candidate.held = true;
        // Two different reasons a ripe candidate is not moving, and telling
        // someone the queue is full while nothing is running sends them to look
        // in the wrong place entirely.
        logger.info(
          transcriber.halted
            ? t('msg.trHeldHalted', { track: candidate.track })
            : t('msg.trHeld', { track: candidate.track }),
        );
      }
      return;
    }

    watching.delete(candidate.videoId);
    if (outcome === 'queued') {
      logger.info(t('msg.trQueued', { track: candidate.track, count: transcriber.queue.length }));
    }
  }
}

/** Make room by dropping the track the least listening is invested in. */
function forgetLeastListened() {
  let victim = null;
  for (const candidate of watching.values()) {
    if (candidate.ripe) continue; // one that already earned its place stays
    if (!victim || candidate.watched < victim.watched) victim = candidate;
  }
  // Everything is ripe and waiting for a slot: drop the oldest instead, since
  // insertion order is the closest thing to a queue position they have.
  if (!victim) victim = watching.values().next().value;
  if (victim) watching.delete(victim.videoId);
}

/** The part-listened track playing right now, for the settings window. */
function waitingForReport() {
  const current = session.state && watching.get(session.state.videoId);
  if (!current) return null;
  return {
    track: current.track || null,
    inSeconds: Math.max(
      0,
      Math.round((config.get('transcribeAfterSeconds') ?? 45) - current.watched),
    ),
    ripe: current.ripe,
  };
}

/**
 * Log a stuck player once per track.
 *
 * Investigated from a real occurrence: the pipeline sat in kStarting for
 * 36 seconds, picked up a duration after 18, and never played — no error code
 * anywhere. The demuxer was simply never fed. Recording readyState and
 * networkState at that moment says which layer gave up, so the next occurrence
 * explains itself instead of needing someone watching.
 */
function reportFault(payload) {
  const fault = payload?.fault;
  if (!fault) {
    faultNoted = null;
    return;
  }
  const key = `${payload.videoId}:${fault.errorCode ?? 'none'}:${fault.readyState}`;
  if (faultNoted === key) return;
  faultNoted = key;

  // Now that a fault is reported for ordinary buffering too, only a genuine
  // dead end warrants a warning; the rest is background noise until the
  // watchdog decides it has lasted too long.
  const serious = fault.errorCode != null || fault.networkState === 3;
  const say = serious ? logger.warn.bind(logger) : logger.debug.bind(logger);

  say(
    t('msg.playerStuck', {
      readyState: fault.readyState,
      networkState: fault.networkState,
      buffered: fault.buffered,
      error:
        fault.errorCode == null
          ? t('msg.noErrorCode')
          : `${fault.errorCode}${fault.errorMessage ? ` (${fault.errorMessage})` : ''}`,
    }),
  );
}

/**
 * What is playing, spelled the way every other surface spells it.
 *
 * The log used to print the wire payload, which still carries "(Official
 * Video)" and friends. session.displayTitle() is the same cleaning the presence
 * and the settings preview apply, and it honours the cleanTitles setting.
 */
function trackLabel() {
  return session.displayTitle(config.get('cleanTitles') !== false) || '—';
}

function resetLyrics() {
  lyricState.trackId = null;
  lyricState.lines = null;
  lyricState.status = 'idle';
  lyricState.current = null;
  lyricState.origin = null;
  lyricState.nextTime = null;
  lyricState.merged = 1;
  lyricState.blocks = null;
  lyricState.fromLibrary = false;
  lyricState.libraryManaged = false;
}

// ---------------------------------------------------------------------- tray

function setupTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Overtone');
  // Left click shows the popup window; the native menu stays on right click,
  // because a window cannot be a context menu and some people expect one.
  tray.on('click', () => toggleTrayPopup());
  tray.on('double-click', () => openSettings());
  refreshUi();
}

/**
 * The tray popup.
 *
 * A frameless window rather than a native menu: a menu cannot show artwork, a
 * progress bar or a lyric. It hides on blur so it still behaves like one.
 */
function toggleTrayPopup() {
  if (trayWindow && !trayWindow.isDestroyed() && trayWindow.isVisible()) {
    trayWindow.hide();
    return;
  }

  if (!trayWindow || trayWindow.isDestroyed()) {
    trayWindow = new BrowserWindow({
      width: 340,
      height: 200,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true },
    });
    trayWindow.loadFile(path.join(__dirname, '..', 'ui', 'tray.html'));
    trayWindow.on('blur', () => trayWindow?.hide());
  }

  positionTrayPopup();
  trayWindow.show();
  trayWindow.webContents.send('tray:show');
}

/** Anchor the popup to the tray icon, kept inside the screen it sits on. */
function positionTrayPopup() {
  const bounds = tray?.getBounds?.();
  const size = trayWindow.getBounds();
  if (!bounds || !bounds.width) {
    trayWindow.center();
    return;
  }

  const { screen } = require('electron');
  const area = screen.getDisplayMatching(bounds).workArea;
  const x = Math.round(
    Math.min(Math.max(area.x + 8, bounds.x + bounds.width / 2 - size.width / 2), area.x + area.width - size.width - 8),
  );
  // Taskbar at the top or the bottom decides which side the popup opens on.
  const y = bounds.y > area.y + area.height / 2 ? bounds.y - size.height - 8 : bounds.y + bounds.height + 8;
  trayWindow.setPosition(x, Math.round(y), false);
}

function trayIcon() {
  const name = discord?.connected ? 'tray-active.png' : 'tray-idle.png';
  const image = nativeImage.createFromPath(path.join(ASSETS, name));
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

function buildTrayMenu() {
  const cfg = config.all();
  const state = session.state;

  const nowPlaying = state
    ? `${state.paused ? '⏸ ' : '▶ '}${truncate(state.title, 48)}`
    : t('tray.nothingPlaying');

  const link = (up) => t(up ? 'tray.connected' : 'tray.disconnected');

  return Menu.buildFromTemplate([
    { label: `Overtone ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: nowPlaying, enabled: false },
    {
      label: t('tray.discord', { state: link(discord?.connected) }),
      enabled: false,
    },
    {
      label: t('tray.browser', {
        state: bridge?.clientCount
          ? t('tray.clientsConnected', { count: bridge.clientCount })
          : link(false),
      }),
      enabled: false,
    },
    { label: t('tray.lyricsLine', { state: lyricsStatusLabel() }), enabled: false },
    { type: 'separator' },
    {
      label: t('tray.menu.presence'),
      type: 'checkbox',
      checked: cfg.enabled,
      click: (item) => setEnabled(item.checked),
    },
    {
      label: t('tray.menu.lyrics'),
      type: 'checkbox',
      checked: cfg.lyricsEnabled,
      click: (item) => config.set({ lyricsEnabled: item.checked }),
    },
    {
      label: t('tray.menu.privacy'),
      type: 'checkbox',
      checked: cfg.privacyMode,
      click: (item) => config.set({ privacyMode: item.checked }),
    },
    { type: 'separator' },
    { label: t('tray.menu.settings'), click: () => openSettings() },
    {
      label: t('tray.openLyrics'),
      click: () => shell.openPath(path.join(app.getPath('userData'), 'lyrics')),
    },
    {
      label: t('tray.openLogs'),
      click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
    },
    {
      label: t('tray.menu.autoStart'),
      type: 'checkbox',
      checked: cfg.autoStart,
      click: (item) => config.set({ autoStart: item.checked }),
    },
    { type: 'separator' },
    { label: t('tray.menu.quit'), click: () => app.quit() },
  ]);
}

function lyricsStatusLabel() {
  if (lyricState.current) {
    const badge = lyricState.origin === 'captions' ? ` (${t('tray.lyr.captionBadge')})` : '';
    return `${truncate(lyricState.current, 36)}${badge}`;
  }
  return {
    idle: '–',
    loading: t('tray.lyr.searching'),
    found: t('tray.lyr.synced'),
    captions: t('tray.lyr.captions'),
    none: t('tray.lyr.none'),
    disabled: t('tray.lyr.off'),
  }[lyricState.status];
}

// ------------------------------------------------------------------ settings

function openWizard() {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.show();
    wizardWindow.focus();
    return;
  }

  wizardWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: '#0c0c11',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true },
  });

  wizardWindow.loadFile(path.join(__dirname, '..', 'ui', 'wizard.html'));
  wizardWindow.once('ready-to-show', () => wizardWindow.show());
  wizardWindow.on('closed', () => {
    wizardWindow = null;
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 560,
    minHeight: 560,
    title: t('win.settings'),
    icon: path.join(ASSETS, 'icon-256.png'),
    backgroundColor: '#12121a',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // Frameless: the design draws its own title bar, so the buttons in it are
    // wired through IPC rather than handled by the OS.
    frame: false,
    minWidth: 900,
    minHeight: 560,
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'ui', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  // Keep external links out of the settings chrome.
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerIpc() {
  ipcMain.handle('config:get', () => config.all());
  ipcMain.handle('config:set', (_event, patch) => {
    config.set(patch);
    return config.all();
  });
  ipcMain.handle('config:reset', () => {
    config.reset();
    return config.all();
  });
  ipcMain.handle('status:get', () => statusSnapshot());
  ipcMain.handle('log:history', () => logger.history());
  ipcMain.handle('lyrics:clearCache', async () => {
    await lyrics.clearCache();
    resetLyrics();
    logger.info(t('msg.cacheCleared'));
    return true;
  });

  // --- the lyrics folder ---------------------------------------------------
  //
  // Every one of these takes a file name from the renderer, so every one of
  // them goes through library.resolve() — see the note on it. Nothing here
  // takes a path.

  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:read', (_event, name) => library.read(name));

  ipcMain.handle('library:reveal', (_event, name) => {
    const file = library.resolve(name);
    if (file) shell.showItemInFolder(file);
  });

  ipcMain.handle('library:write', async (_event, name, text) => {
    const outcome = await library.write(name, text);
    if (outcome !== 'saved') return outcome;
    logger.info(t('msg.libraryEdited', { file: name }));
    // The file changed under a lookup that already ran. Same move the
    // transcriber makes on 'done': force the next tick to read it again rather
    // than keep the lines loaded at track change.
    lyricState.trackId = null;
    refreshUi();
    return outcome;
  });

  ipcMain.handle('library:remove', async (_event, name) => {
    const entry = await library.read(name);
    if (!entry) return 'missing';

    // A file this program did not write is a version somebody made or corrected
    // themselves. It costs a second, explicit yes, in a dialog that names it.
    if (!entry.managed) {
      const { response } = await dialog.showMessageBox(settingsWindow ?? undefined, {
        type: 'warning',
        buttons: [t('lib.delete'), t('lib.cancel')],
        defaultId: 1,
        cancelId: 1,
        title: t('lib.deleteTitle'),
        message: t('lib.deleteOwn', { file: name }),
        detail: t('lib.deleteOwnDetail'),
      });
      if (response !== 0) return 'cancelled';
    }

    const outcome = await library.remove(name, { force: true });
    if (outcome === 'deleted') {
      logger.info(t('msg.libraryDeleted', { file: name }));
      lyricState.trackId = null;
      refreshUi();
    }
    return outcome;
  });

  ipcMain.handle('plugins:list', () => plugins.describe(getLocale()));

  ipcMain.handle('plugins:reload', async () => {
    await plugins.scan();
    return plugins.describe(getLocale());
  });

  ipcMain.handle('plugins:setEnabled', async (_event, id, on) => {
    if (!plugins.manifestFor(id)) return false;
    pluginStore.setEnabled(id, on);
    await startSurface();
    refreshUi();
    return true;
  });

  ipcMain.handle('plugins:surface', () => ({
    running: surface.running,
    port: surface.port,
    error: surface.error,
    addresses: Object.fromEntries(plugins.surfaces().map((p) => [p.id, surface.addressFor(p.id)])),
  }));

  ipcMain.handle('plugins:newAddress', async () => {
    // Forgetting it is what retires it: startSurface() mints another and writes
    // that one down instead.
    config.set({ surfaceToken: '' });
    await surface.stop();
    await startSurface();
    refreshUi();
    return surface.running;
  });

  ipcMain.handle('plugins:setSetting', (_event, id, key, value) => {
    // Falls through to refreshUi() below, which pushes to every open page —
    // that is how a slider in the panel reaches a Browser Source already open.
    // Checked against the manifest rather than trusted: this arrives from the
    // renderer, and a field the plugin never declared has no business being
    // stored under its name.
    const manifest = plugins.manifestFor(id);
    const field = manifest?.settings.find((f) => f.key === key && f.type !== 'note');
    if (!field) return false;

    pluginStore.setValue(id, key, value);
    refreshUi();
    return true;
  });

  ipcMain.handle('plugins:examples', async () => {
    const dir = examplesPath();
    let names = [];
    try {
      names = (await require('node:fs/promises').readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    // Only the ones not already there. An example the user has installed is
    // their plugin now, and offering to add it again invites overwriting it.
    return names.filter((name) => !plugins.has(name));
  });

  ipcMain.handle('plugins:addExample', async (_event, id) => {
    const fsp = require('node:fs/promises');
    const from = path.join(examplesPath(), path.basename(String(id || '')));
    const to = path.join(app.getPath('userData'), 'plugins', path.basename(String(id || '')));

    // Never over the top of something already there. Whatever a person has in
    // their own folder is theirs, even when it shares a name with an example.
    if (plugins.has(path.basename(String(id || '')))) return 'exists';

    try {
      await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (err) {
      logger.warn(t('msg.plugExampleFailed', { id, error: err.message }));
      return 'failed';
    }

    await plugins.scan();
    logger.info(t('msg.plugExampleAdded', { id }));
    refreshUi();
    return 'added';
  });

  ipcMain.handle('plugins:openFolder', () => shell.openPath(path.join(app.getPath('userData'), 'plugins')));

  ipcMain.handle('plugins:reveal', (_event, id) => {
    const dir = plugins.dirFor(id);
    if (dir) shell.openPath(dir);
    return Boolean(dir);
  });

  ipcMain.handle('library:regenerate', async (_event, name) => {
    const entry = await library.read(name);
    if (!entry) return 'missing';
    // Both store() and the Whisper worker refuse to replace a file they did not
    // write. Say so now rather than queue a job that dies at its last step.
    if (!entry.managed) return 'protected';

    const videoId = name.slice(0, -4);
    // Only an id-named file can be regenerated: the worker downloads by video
    // id, and "Artist - Title.lrc" does not say which upload it came from.
    if (!/^[\w-]{11}$/.test(videoId)) return 'noVideo';
    if (transcriber.busy) return 'busy';

    transcriber.forget(videoId);
    logger.info(t('msg.libraryRegenerate', { file: name }));

    return transcriber.submit({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      artist: entry.artist,
      track: entry.title,
      config: config.all(),
      getConfig: () => config.all(),
    });
  });
  ipcMain.handle('discord:reconnect', () => {
    logger.info(t('msg.reconnecting'));
    // setupDiscord() replaces both objects, so retire the old pair first —
    // otherwise the previous controller keeps a live timer on a dead socket.
    presence?.stop();
    discord?.destroy();
    setupDiscord();
    tick();
    return true;
  });
  ipcMain.handle('i18n:get', () => ({
    // The resolved language, not the setting: 'sys' is a choice, not a locale,
    // and the windows format numbers and dates with what they get here.
    locale: getLocale(),
    languages: LANGUAGES,
    dictionary: dictionary(),
  }));

  ipcMain.handle('app:pickCookiesFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(settingsWindow ?? undefined, {
      title: t('tr.cookiesPick'),
      properties: ['openFile'],
      filters: [{ name: 'cookies.txt', extensions: ['txt'] }],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('app:extensionPath', () =>
    app.isPackaged
      ? path.join(process.resourcesPath, 'extension')
      : path.join(__dirname, '..', '..', 'extension'),
  );
  ipcMain.handle('app:showExtensionFolder', async () => {
    const target = app.isPackaged
      ? path.join(process.resourcesPath, 'extension')
      : path.join(__dirname, '..', '..', 'extension');
    shell.showItemInFolder(target);
  });

  ipcMain.handle('wizard:finish', () => {
    wizardWindow?.close();
    // Straight into the settings so the window they will actually live in is
    // the one that opens next, rather than nothing at all.
    openSettings();
  });

  ipcMain.handle('tray:openSettings', () => {
    trayWindow?.hide();
    openSettings();
  });
  // The popup sizes itself: a fixed height left transparent dead space below
  // the content, which Windows renders as a faint smear rather than nothing.
  ipcMain.handle('tray:resize', (_event, height) => {
    if (!trayWindow || trayWindow.isDestroyed()) return;
    const wanted = Math.round(Number(height) || 0);
    if (!Number.isFinite(wanted) || wanted < 120 || wanted > 700) return;

    const bounds = trayWindow.getBounds();
    if (bounds.height === wanted) return;
    trayWindow.setBounds({ ...bounds, height: wanted }, false);
    positionTrayPopup();
  });

  ipcMain.handle('tray:quit', () => {
    trayWindow?.hide();
    app.quit();
  });

  ipcMain.handle('app:openLyricsFolder', () =>
    shell.openPath(path.join(app.getPath('userData'), 'lyrics')),
  );
  ipcMain.handle('app:openLogFolder', () =>
    shell.openPath(path.join(app.getPath('userData'), 'logs')),
  );

  ipcMain.handle('window:minimise', () => settingsWindow?.minimize());
  ipcMain.handle('window:toggleMaximise', () => {
    if (!settingsWindow) return;
    if (settingsWindow.isMaximized()) settingsWindow.unmaximize();
    else settingsWindow.maximize();
  });
  // Hidden rather than destroyed: reopening from the tray should be instant,
  // and the agent goes on working with no window at all.
  ipcMain.handle('window:close', () => settingsWindow?.hide());

  ipcMain.handle('app:openExternal', (_event, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url));
  });
}

// ------------------------------------------------------------------ plumbing

/**
 * The popup's strings, sent along with the status.
 *
 * The extension cannot read the agent's locale files, and giving it its own
 * copy would mean two places to translate the same sentences. So the agent
 * sends the handful of keys the popup uses and the popup just renders them.
 */
function popupStrings() {
  const dict = dictionary();
  const out = {};
  for (const key of Object.keys(dict)) {
    if (key.startsWith('popup.')) out[key] = dict[key];
  }
  return out;
}

function statusSnapshot() {
  const state = session.state;
  return {
    version: app.getVersion(),
    i18n: popupStrings(),
    enabled: config.get('enabled'),
    discordConnected: Boolean(discord?.connected),
    discordUser: discord?.user?.username || null,
    browserClients: bridge?.clientCount ?? 0,
    port: config.get('port'),
    lastError,
    extension: {
      version: extension.version,
      features: extension.features,
      // Sent so the extension can mirror it into chrome.storage, which is the
      // only place its content script can read a setting from.
      autoReload: config.get('watchdogEnabled') !== false,
      appVersion: app.getVersion(),
      outdated: Boolean(extension.version) && extension.version !== app.getVersion(),
      /**
       * The content script in the reporting tab is too old to send subtitles.
       * Keyed off the snapshot, not the extension handshake — see
       * session.js#captionCapable for why the handshake cannot tell us this.
       */
      captionsUnsupported: Boolean(state) && !state.captionCapable,
    },
    transcription: transcriber
      ? {
          ...transcriber.report(),
          // A job that has not started yet is the most common reason the whole
          // thing "seems delayed"; without this the window shows only idleness.
          waitingFor: waitingForReport(),
          // Everything else that has collected listening time. These were
          // invisible until now, because only one could exist at a time.
          watching: [...watching.values()]
            .filter((item) => item.videoId !== session.state?.videoId)
            .map((item) => item.track || item.videoId),
        }
      : null,
    lyrics: {
      status: lyricState.status,
      line: lyricState.current,
      lineCount: lyricState.lines?.length ?? 0,
      origin: lyricState.origin,
      // `origin` says what is on screen this instant, so it goes null the
      // moment playback pauses and cannot name the source of loaded lines.
      // This can, and is guarded so a stale flag never leaks out.
      fromLibrary: lyricState.status === 'found' && lyricState.fromLibrary,
      libraryManaged:
        lyricState.status === 'found' && lyricState.fromLibrary && lyricState.libraryManaged,
      merged: lyricState.merged,
      transcribing: transcriber?.busyWith === session.state?.videoId,
      captionsAvailable: Boolean(state?.caption),
      captionTrack: state?.captionTrack || null,
    },
    now: state
      ? {
          // Cleaned the same way the presence is, so no surface disagrees.
      title: session.displayTitle(config.get('cleanTitles') !== false),
          artist: state.artist || state.channel,
          source: state.source,
          paused: state.paused,
          position: Math.round(state.position),
          duration: Math.round(state.duration),
          url: state.url,
          // Regular YouTube snapshots carry no artwork — the agent derives it
          // from the video id. Derive it here too, or the settings preview
          // shows an empty box for every non-Music track.
          thumbnail:
            state.thumbnail || (state.videoId ? youtubeThumb(state.videoId, 'hqdefault') : null),
        }
      : null,
  };
}

function refreshUi() {
  if (tray && !tray.isDestroyed?.()) {
    tray.setContextMenu(buildTrayMenu());
    tray.setImage(trayIcon());

    const state = session.state;
    // The same cleaning every other surface applies, and the two idle states
    // named from the dictionary — this tooltip was the last thing in the app
    // still speaking one fixed language, and it is what a hover reads out.
    tray.setToolTip(
      state
        ? `Overtone — ${truncate(trackLabel(), 60)}`
        : `Overtone — ${t(discord?.connected ? 'tray.ready' : 'tray.waitingDiscord')}`,
    );
  }

  const snapshot = statusSnapshot();
  sendToSettings('status:update', snapshot);
  bridge?.broadcast('status', snapshot);
  surface?.publish();
}

function sendToSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function setEnabled(enabled) {
  config.set({ enabled });
  if (!enabled) {
    presence.clear();
    logger.info(t('msg.presenceOff'));
  } else {
    logger.info(t('msg.presenceOn'));
    tick();
  }
}

/**
 * Put the chosen language into effect.
 *
 * 'sys' follows the operating system; anything we do not ship falls back to
 * English, which is also the default — the presence text is read by other
 * people, and English is the safest thing for them to meet.
 */
function applyLanguage() {
  const choice = config.get('language');
  setLocale(choice === 'sys' ? detect(app.getLocale()) : choice);
}

function onConfigChanged(changed) {
  if (changed.includes('language')) {
    applyLanguage();
    // Open windows hold their own copy of the dictionary, so hand them the new
    // one rather than making them ask for it.
    for (const win of [settingsWindow, wizardWindow, trayWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('i18n:changed', { dictionary: dictionary(), locale: getLocale() });
    }
    refreshUi();
  }
  logger.debug(t('msg.settingsChanged', { keys: changed.join(', ') }));

  if (changed.includes('clientId')) discord.setClientId(config.get('clientId'));
  if (changed.includes('port')) {
    bridge.setPort(config.get('port')).catch((err) => {
      logger.error(t('msg.portChangeFailed', { error: err.message }));
    });
  }
  if (changed.includes('pluginSurfacePort')) {
    startSurface().then(refreshUi);
  }
  if (changed.includes('autoStart')) applyAutoStart();
  if (changed.includes('lyricsEnabled')) resetLyrics();

  refreshUi();
  tick();
}

function applyAutoStart() {
  // Linux desktops need a .desktop file, which electron-builder installs; the
  // API is a no-op there rather than an error, so guard to avoid confusion.
  if (process.platform === 'linux') return;

  app.setLoginItemSettings({
    openAtLogin: config.get('autoStart'),
    args: ['--hidden'],
  });
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
