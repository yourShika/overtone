'use strict';

/**
 * Settings window renderer.
 *
 * Sandboxed: everything goes through `window.overtone` from the preload script.
 * Inputs write straight through on change (no Save button) because every value
 * takes effect on the next tick anyway — an explicit save would only add a step
 * where the UI and the running config can disagree.
 */

const api = window.overtone;

/** id -> how the value is read/written */
const FIELDS = {
  clientId: 'text',
  port: 'number',
  activityType: 'text',
  activityName: 'text',
  showTimestamps: 'bool',
  highResArtwork: 'bool',
  showButton: 'bool',
  buttonLabel: 'text',
  showChannelButton: 'bool',
  hideWhenPaused: 'bool',
  privacyMode: 'bool',
  lyricsEnabled: 'bool',
  lyricsSource: 'text',
  lyricsMusicOnly: 'bool',
  lyricsProminent: 'bool',
  lyricsCombine: 'number',
  lyricsOffset: 'number',
  enabled: 'bool',
  autoStart: 'bool',
};

const $ = (id) => document.getElementById(id);

let suppressWrites = false;

init().catch((err) => console.error(err));

async function init() {
  const config = await api.config.get();
  applyConfig(config);
  bindFields();
  bindButtons();
  bindExternalLinks();

  applyStatus(await api.status.get());
  api.status.onUpdate(applyStatus);

  for (const entry of await api.log.history()) appendLog(entry);
  api.log.onEntry(appendLog);
}

// ------------------------------------------------------------------- config

function applyConfig(config) {
  suppressWrites = true;

  for (const [id, kind] of Object.entries(FIELDS)) {
    const el = $(id);
    if (!el) continue;
    if (kind === 'bool') el.checked = Boolean(config[id]);
    else el.value = config[id] ?? '';
  }

  updateDependentState();
  suppressWrites = false;
}

function bindFields() {
  for (const [id, kind] of Object.entries(FIELDS)) {
    const el = $(id);
    if (!el) continue;

    const commit = () => {
      if (suppressWrites) return;
      const value = kind === 'bool' ? el.checked : kind === 'number' ? Number(el.value) : el.value;
      api.config.set({ [id]: value });
      updateDependentState();
    };

    if (el.tagName === 'INPUT' && (kind === 'text' || kind === 'number')) {
      // Debounced rather than commit-on-blur: closing the window right after
      // typing does not reliably fire `change`, and losing a freshly pasted
      // client id that way is a miserable first-run experience.
      el.addEventListener('input', debounce(commit, 400));
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    } else {
      el.addEventListener('input', commit);
    }
  }

  $('lyricsOffset').addEventListener('input', updateDependentState);

  // Last line of defence: flush anything still pending when the window goes.
  window.addEventListener('pagehide', flushPending);
  window.addEventListener('beforeunload', flushPending);
}

/** @type {Map<Function, ReturnType<typeof setTimeout>>} */
const pending = new Map();

function debounce(fn, delay) {
  return () => {
    clearTimeout(pending.get(fn));
    pending.set(
      fn,
      setTimeout(() => {
        pending.delete(fn);
        fn();
      }, delay),
    );
  };
}

function flushPending() {
  for (const [fn, timer] of pending) {
    clearTimeout(timer);
    fn();
  }
  pending.clear();
}

/** Grey out options whose parent toggle is off, and refresh the range output. */
function updateDependentState() {
  const offset = Number($('lyricsOffset').value || 0);
  $('lyricsOffsetOut').textContent = offset.toFixed(1).replace('.', ',');

  setGroupEnabled(['buttonLabel', 'showChannelButton'], $('showButton').checked);
  const lyricsOn = $('lyricsEnabled').checked;
  setGroupEnabled(
    ['lyricsSource', 'lyricsMusicOnly', 'lyricsProminent', 'lyricsCombine', 'lyricsOffset'],
    lyricsOn,
  );
  // Both the offset and merging need a source we can read ahead in.
  const canLookAhead = lyricsOn && $('lyricsSource').value !== 'captions';
  setGroupEnabled(['lyricsOffset', 'lyricsCombine'], canLookAhead);
}

function setGroupEnabled(ids, enabled) {
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !enabled;
    const wrapper = el.closest('.field, .toggle');
    if (wrapper) wrapper.style.opacity = enabled ? '1' : '0.45';
  }
}

// ------------------------------------------------------------------- status

function applyStatus(status) {
  if (!status) return;

  $('version').textContent = `Version ${status.version} · Port ${status.port}`;

  setPill('pill-discord', status.discordConnected, status.discordUser ? `Discord · @${status.discordUser}` : 'Discord');
  setPill('pill-browser', status.browserClients > 0, `Browser${status.browserClients ? ` · ${status.browserClients}` : ''}`);

  $('last-error').textContent = status.lastError || '';

  renderNowPlaying(status);
  renderLyricStatus(status.lyrics);
  renderExtensionWarning(status);
}

/**
 * The failure that is otherwise invisible: the YouTube tab is still running the
 * content script it was opened with, from before the update, so no subtitles
 * ever arrive. Reloading the extension alone does not fix it — the tab has to
 * be reloaded too.
 */
function renderExtensionWarning(status) {
  const el = $('extension-warning');
  const outdated = status.extension?.captionsUnsupported;
  const wantsCaptions = $('lyricsEnabled').checked && $('lyricsSource').value !== 'lrclib';

  if (!outdated || !wantsCaptions) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  el.textContent =
    'Dieser YouTube-Tab läuft mit einem veralteten Content-Script und kann keine ' +
    'Untertitel senden. In brave://extensions bzw. chrome://extensions auf ↻ klicken ' +
    'und danach den YouTube-Tab neu laden (F5).';
}

function setPill(id, on, label) {
  const el = $(id);
  el.dataset.state = on ? 'on' : 'off';
  el.textContent = label;
}

function renderNowPlaying(status) {
  const live = $('preview-live');
  const empty = $('preview-empty');

  if (!status.now) {
    live.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  live.classList.remove('hidden');

  const now = status.now;
  const lyric = status.lyrics?.line;
  const byline = now.artist || '—';

  // Mirror the same line-order rule buildActivity uses, so the preview keeps
  // telling the truth when the prominence toggle flips.
  if (lyric && $('lyricsProminent').checked) {
    $('preview-title').textContent = `♪ ${lyric}`;
    $('preview-state').textContent = secondLine(now.title, now.artist);
  } else {
    $('preview-title').textContent = now.title || '—';
    $('preview-state').textContent = lyric ? `♪ ${lyric}` : byline;
  }

  $('preview-time').textContent = formatProgress(now);

  const art = $('preview-art');
  // CSP only allows YouTube/Google image hosts; anything else stays blank
  // rather than triggering a console violation.
  if (now.thumbnail && /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\//.test(now.thumbnail)) {
    if (art.src !== now.thumbnail) art.src = now.thumbnail;
  } else {
    art.removeAttribute('src');
  }
}

/** Mirrors secondLine() in src/discord/activity.js — the sandbox blocks reuse. */
function secondLine(title, byline) {
  if (!byline) return title || '—';
  if (!title) return byline;

  const simplify = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

  return simplify(title).includes(simplify(byline)) ? title : `${byline} – ${title}`;
}

function renderLyricStatus(lyrics) {
  if (!lyrics) return;
  const el = $('lyric-status');

  // What is actually driving the line matters more than which lookup ran, so
  // report the origin first when there is one.
  if (lyrics.origin === 'captions' && lyrics.line) {
    const track = lyrics.captionTrack ? ` · Spur ${lyrics.captionTrack}` : '';
    el.textContent = `Aus YouTube-Untertiteln${track}`;
    return;
  }
  if (lyrics.origin === 'lrclib' && lyrics.lineCount) {
    const merged = lyrics.merged > 1 ? ` · ${lyrics.merged} Zeilen zusammengefasst` : '';
    el.textContent = `Aus LRCLIB · ${lyrics.lineCount} Zeilen synchronisiert${merged}`;
    return;
  }

  const base = {
    idle: '',
    loading: 'Lyrics werden gesucht …',
    found: `Lyrics synchronisiert · ${lyrics.lineCount} Zeilen`,
    captions: 'Warte auf Untertitel …',
    none: 'Keine Lyrics gefunden.',
    disabled: 'Lyrics sind deaktiviert.',
  }[lyrics.status] ?? '';

  // The single most common cause of "nothing shows up" — say so plainly.
  const hint =
    lyrics.status === 'none' && !lyrics.captionsAvailable
      ? ' Untertitel im YouTube-Player einschalten, dann werden sie verwendet.'
      : '';

  el.textContent = base + hint;
}

function formatProgress(now) {
  if (now.paused) return 'Pausiert';
  if (!now.duration) return `${formatTime(now.position)} · Live`;
  return `${formatTime(now.position)} / ${formatTime(now.duration)}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ------------------------------------------------------------------ actions

function bindButtons() {
  $('btn-reconnect').addEventListener('click', () => api.actions.reconnectDiscord());

  $('btn-clear-cache').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await api.actions.clearLyricsCache();
    button.textContent = 'Cache geleert ✓';
    setTimeout(() => {
      button.textContent = 'Lyrics-Cache leeren';
      button.disabled = false;
    }, 1800);
  });

  $('btn-reset').addEventListener('click', async () => {
    applyConfig(await api.config.reset());
  });
}

/** Links open in the real browser, never inside the settings window. */
function bindExternalLinks() {
  for (const link of document.querySelectorAll('[data-external]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      api.actions.openExternal(link.dataset.external);
    });
  }
}

// ---------------------------------------------------------------------- log

const logEl = () => $('log');

function appendLog(entry) {
  const el = logEl();
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  const line = document.createElement('div');
  line.className = entry.level;
  line.textContent = `${new Date(entry.ts).toLocaleTimeString('de-DE')}  ${entry.message}`;
  el.appendChild(line);

  while (el.childElementCount > 300) el.removeChild(el.firstChild);
  if (atBottom) el.scrollTop = el.scrollHeight;
}
