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
const { Logger } = require('./log');
const { Bridge } = require('./bridge');
const { Session } = require('./session');
const { DiscordIPC } = require('./discord/ipc');
const { PresenceController } = require('./discord/presence');
const { buildActivity } = require('./discord/activity');
const { LyricsProvider } = require('./lyrics/lrclib');
const { lyricWindow } = require('./lyrics/lrc');
const { parseTrack } = require('./lyrics/trackparse');
const { ThumbnailResolver, youtubeThumb } = require('./thumbnails');

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

let config;
let logger;
let bridge;
let discord;
let presence;
let lyrics;
let thumbnails;

const session = new Session();
let tickTimer = null;

/** Lyrics state for the currently playing track. */
const lyricState = {
  trackId: null,
  lines: null,
  status: 'idle', // idle | loading | found | none | captions | disabled
  current: null,
  origin: null, // 'lrclib' | 'captions' — where the shown line came from
  nextTime: null, // track seconds; cue of the first line not yet shown
  merged: 1, // how many lyric lines the current text carries
};

let lastError = null;

/** What the connected browser extension told us it can do. */
const extension = { version: null, features: [] };

// ---------------------------------------------------------------------- boot

app.whenReady().then(async () => {
  const userData = app.getPath('userData');

  config = new Config(path.join(userData, 'config.json'));
  logger = new Logger({
    filePath: path.join(userData, 'logs', 'overtone.log'),
    level: process.argv.includes('--verbose') ? 'debug' : 'info',
    onEntry: (entry) => sendToSettings('log:entry', entry),
  });

  logger.info(`Overtone Agent ${app.getVersion()} startet …`);
  for (const note of config.migrations) logger.info(`Einstellung angepasst: ${note}`);

  thumbnails = new ThumbnailResolver({ logger });
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

  if (!config.get('clientId')) {
    logger.warn('Keine Discord Client-ID gesetzt — Einstellungen werden geöffnet.');
    openSettings();
  }
});

// Electron quits when the last window closes *unless* something listens here.
// A tray app spends most of its life without any window, so we listen and do
// nothing on purpose.
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
  await bridge?.stop();
  logger?.close();
});

// ------------------------------------------------------------------- discord

function setupDiscord() {
  discord = new DiscordIPC(config.get('clientId'));

  discord.on('connected', ({ user }) => {
    lastError = null;
    const tag = user?.username ? `@${user.username}` : 'unbekannt';
    logger.info(`Mit Discord verbunden (${tag})`);
    refreshUi();
  });

  discord.on('disconnected', ({ reason }) => {
    logger.warn(`Discord-Verbindung getrennt (${reason})`);
    refreshUi();
  });

  discord.on('retry', ({ reason, delay }) => {
    logger.debug(`Neuer Discord-Versuch in ${Math.round(delay / 1000)}s (${reason})`);
  });

  discord.on('error', (err) => {
    lastError = err.message;
    logger.error(`Discord: ${err.message}`);
    refreshUi();
  });

  presence = new PresenceController(discord, {
    // Pulled at the instant a frame is sent, so the lyric line is the one
    // that is current *then* rather than when the tick noticed a change.
    provider: () => {
      if (!config.get('enabled') || !session.active) return null;
      const state = session.state;
      const cfg = config.all();
      return buildActivity({
        state,
        config: cfg,
        lyric: currentLyricLine(state, cfg),
        image: latestImage,
      });
    },
    onSend: (activity) => {
      logger.debug(`→ Discord: ${activity ? activity.details : '(geleert)'}`);
      refreshUi();
    },
  });

  discord.connect();
}

// -------------------------------------------------------------------- bridge

async function setupBridge() {
  bridge = new Bridge({ port: config.get('port'), logger });

  bridge.on('state', (payload) => {
    if (!config.get('enabled')) return;

    const change = session.update(payload);
    if (change.trackChanged) {
      logger.info(`Neu: ${payload.title || '(ohne Titel)'}`);
      resetLyrics();

      // Warn once per track rather than once per report, so the log stays
      // readable while still being impossible to miss.
      if (!session.raw.captionCapable && config.get('lyricsSource') !== 'lrclib') {
        logger.warn(
          'Dieser Tab läuft mit einem veralteten Content-Script und kann keine ' +
            'Untertitel senden. Extension in brave://extensions neu laden (↻) ' +
            'UND den YouTube-Tab aktualisieren.',
        );
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
    logger.debug(`Wiedergabe beendet (${payload?.reason || 'unbekannt'})`);
    session.clear();
    resetLyrics();
    presence.clear();
    refreshUi();
  });

  bridge.on('hello', (payload, socket) => {
    extension.version = payload.version || null;
    extension.features = Array.isArray(payload.features) ? payload.features : [];

    logger.info(
      `Extension verbunden: ${payload.client || '?'} v${extension.version || '?'}` +
        (extension.features.length ? ` [${extension.features.join(', ')}]` : ''),
    );

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
    logger.error(`Bridge konnte nicht starten: ${err.message}`);
    dialog.showErrorBox(
      'Overtone: Port belegt',
      `Port ${config.get('port')} ist bereits belegt.\n\n` +
        'Läuft Overtone vielleicht schon? Andernfalls ändere den Port in den Einstellungen ' +
        '(und in den Extension-Optionen).',
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
  if (!config.get('enabled')) {
    presence.clear();
    return;
  }

  // A snapshot that stopped arriving means the tab or browser is gone.
  if (!session.active) {
    if (session.raw) {
      session.clear();
      resetLyrics();
    }
    presence.clear();
    return;
  }

  const state = session.state;
  const cfg = config.all();

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
    const reach = (presence.step / 1000) * (state.playbackRate || 1) * cfg.lyricsCombine;

    const view = lyricWindow(lyricState.lines, state.position, {
      offset: cfg.lyricsOffset,
      windowSeconds: reach,
      maxChars: LYRIC_MAX_CHARS,
    });

    return {
      text: view.text,
      origin: 'lrclib',
      nextTime: view.nextTime,
      merged: view.text ? view.text.split(' · ').length : 1,
    };
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
  lyricState.current = null;
  refreshUi();

  const parsed = parseTrack(state);
  if (!parsed.track) {
    lyricState.status = 'none';
    return;
  }

  logger.debug(`Lyrics-Suche: "${parsed.artist}" – "${parsed.track}"`);

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
        logger.info(`Lyrics gefunden (${result.lines.length} Zeilen)`);
      } else {
        lyricState.lines = null;
        lyricState.status = 'none';
        logger.debug('Keine synchronisierten Lyrics gefunden');
      }
      refreshUi();
    })
    .catch((err) => {
      if (lyricState.trackId !== state.id) return;
      lyricState.status = 'none';
      logger.warn(`Lyrics-Fehler: ${err.message}`);
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

function resetLyrics() {
  lyricState.trackId = null;
  lyricState.lines = null;
  lyricState.status = 'idle';
  lyricState.current = null;
  lyricState.origin = null;
  lyricState.nextTime = null;
  lyricState.merged = 1;
}

// ---------------------------------------------------------------------- tray

function setupTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Overtone');
  tray.on('double-click', () => openSettings());
  refreshUi();
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
    : 'Nichts läuft';

  return Menu.buildFromTemplate([
    { label: `Overtone ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: nowPlaying, enabled: false },
    {
      label: `Discord: ${discord?.connected ? 'verbunden' : 'getrennt'}`,
      enabled: false,
    },
    {
      label: `Browser: ${bridge?.clientCount ? `${bridge.clientCount} verbunden` : 'getrennt'}`,
      enabled: false,
    },
    { label: `Lyrics: ${lyricsStatusLabel()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Presence aktiv',
      type: 'checkbox',
      checked: cfg.enabled,
      click: (item) => setEnabled(item.checked),
    },
    {
      label: 'Lyrics als Status',
      type: 'checkbox',
      checked: cfg.lyricsEnabled,
      click: (item) => config.set({ lyricsEnabled: item.checked }),
    },
    {
      label: 'Privat-Modus (Titel verbergen)',
      type: 'checkbox',
      checked: cfg.privacyMode,
      click: (item) => config.set({ privacyMode: item.checked }),
    },
    { type: 'separator' },
    { label: 'Einstellungen …', click: () => openSettings() },
    {
      label: 'Log-Ordner öffnen',
      click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')),
    },
    {
      label: 'Beim Anmelden starten',
      type: 'checkbox',
      checked: cfg.autoStart,
      click: (item) => config.set({ autoStart: item.checked }),
    },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]);
}

function lyricsStatusLabel() {
  if (lyricState.current) {
    const badge = lyricState.origin === 'captions' ? ' (Untertitel)' : '';
    return `${truncate(lyricState.current, 36)}${badge}`;
  }
  return {
    idle: '–',
    loading: 'wird gesucht …',
    found: 'synchronisiert',
    captions: 'aus Untertiteln',
    none: 'nicht gefunden',
    disabled: 'aus',
  }[lyricState.status];
}

// ------------------------------------------------------------------ settings

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 560,
    minHeight: 560,
    title: 'Overtone — Einstellungen',
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
    logger.info('Lyrics-Cache geleert');
    return true;
  });
  ipcMain.handle('discord:reconnect', () => {
    logger.info('Discord-Verbindung wird neu aufgebaut …');
    // setupDiscord() replaces both objects, so retire the old pair first —
    // otherwise the previous controller keeps a live timer on a dead socket.
    presence?.stop();
    discord?.destroy();
    setupDiscord();
    tick();
    return true;
  });
  ipcMain.handle('app:openExternal', (_event, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url));
  });
}

// ------------------------------------------------------------------ plumbing

function statusSnapshot() {
  const state = session.state;
  return {
    version: app.getVersion(),
    enabled: config.get('enabled'),
    discordConnected: Boolean(discord?.connected),
    discordUser: discord?.user?.username || null,
    browserClients: bridge?.clientCount ?? 0,
    port: config.get('port'),
    lastError,
    extension: {
      version: extension.version,
      features: extension.features,
      /**
       * The content script in the reporting tab is too old to send subtitles.
       * Keyed off the snapshot, not the extension handshake — see
       * session.js#captionCapable for why the handshake cannot tell us this.
       */
      captionsUnsupported: Boolean(state) && !state.captionCapable,
    },
    lyrics: {
      status: lyricState.status,
      line: lyricState.current,
      lineCount: lyricState.lines?.length ?? 0,
      origin: lyricState.origin,
      merged: lyricState.merged,
      captionsAvailable: Boolean(state?.caption),
      captionTrack: state?.captionTrack || null,
    },
    now: state
      ? {
          title: state.title,
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
    tray.setToolTip(
      state ? `Overtone — ${truncate(state.title, 60)}` : `Overtone — ${discord?.connected ? 'bereit' : 'wartet auf Discord'}`,
    );
  }

  const snapshot = statusSnapshot();
  sendToSettings('status:update', snapshot);
  bridge?.broadcast('status', snapshot);
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
    logger.info('Presence deaktiviert');
  } else {
    logger.info('Presence aktiviert');
    tick();
  }
}

function onConfigChanged(changed) {
  logger.debug(`Einstellungen geändert: ${changed.join(', ')}`);

  if (changed.includes('clientId')) discord.setClientId(config.get('clientId'));
  if (changed.includes('port')) {
    bridge.setPort(config.get('port')).catch((err) => {
      logger.error(`Portwechsel fehlgeschlagen: ${err.message}`);
    });
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
