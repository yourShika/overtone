'use strict';

/**
 * Settings window.
 *
 * Sandboxed: everything reaches the agent through `window.overtone` from the
 * preload script. Values write straight through on change — there is no Save
 * button, because every setting takes effect on the next tick anyway and an
 * explicit save would only add a state where the window and the running config
 * disagree.
 *
 * Controls are bound declaratively from `data-` attributes rather than wired
 * one by one, so adding a setting means adding markup, not more JavaScript.
 */

const api = window.overtone;

/** Text and number inputs, by element id. */
const INPUTS = {
  clientId: 'text',
  port: 'number',
  activityName: 'text',
  buttonLabel: 'text',
  transcribeLanguage: 'text',
  transcribeMaxMinutes: 'number',
  lyricsOffset: 'number',
};

const $ = (id) => document.getElementById(id);
const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));

let config = {};
let status = {};
let logEntries = [];
let logFilter = 'all';
let suppress = false;

init().catch((err) => console.error(err));

async function init() {
  config = await api.config.get();
  // Paint the window in the chosen language before anything else is shown, and
  // repaint the parts built at runtime whenever it changes.
  await T.init(() => {
    render();
    applyStatus(status);
    renderLog();
  });
  fillLanguages();

  applyTheme(config.theme || 'dark', null);
  bindWindowButtons();
  bindNav();
  bindSearch();
  bindInputs();
  bindSwitches();
  bindSegmented();
  bindDisclosures();
  bindActions();

  render();

  applyStatus(await api.status.get());
  api.status.onUpdate(applyStatus);

  logEntries = await api.log.history();
  renderLog();
  api.log.onEntry((entry) => {
    logEntries.push(entry);
    if (logEntries.length > 500) logEntries.shift();
    renderLog();
  });
}

// ----------------------------------------------------------------- writing

function save(patch) {
  if (suppress) return;
  Object.assign(config, patch);
  api.config.set(patch);
  render();
}

/** Reflect the whole config into the controls. */
function render() {
  suppress = true;

  for (const [id, kind] of Object.entries(INPUTS)) {
    const el = $(id);
    if (!el) continue;
    const value = config[id];
    el.value = kind === 'number' ? (value ?? 0) : (value ?? '');
  }

  for (const row of all('[data-switch]')) {
    setSwitch(row, Boolean(config[row.dataset.switch]));
  }

  for (const group of all('[data-seg]')) {
    const key = group.dataset.seg;
    const current = key === 'theme' ? config.theme || 'dark' : config[key];
    for (const button of all('button', group)) {
      const same = String(button.dataset.value) === String(current);
      button.setAttribute('aria-selected', same ? 'true' : 'false');
    }
  }

  // The decimal mark belongs to the language, not to the code — a German
  // comma in an English window looked like a typo.
  const offset = Number(config.lyricsOffset || 0);
  $('lyricsOffsetOut').textContent = `${new Intl.NumberFormat(T.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'always',
  })
    .format(offset)
    // Intl yields a hyphen; the design uses the typographic minus.
    .replace('-', '−')} s`;

  // Dependent blocks follow their switch; merge strength only applies to line mode.
  openSub('showButton', config.showButton);
  openSub('lyricsEnabled', config.lyricsEnabled);
  openSub('transcribeEnabled', config.transcribeEnabled);
  for (const el of all('[data-only="line"]')) {
    el.classList.toggle('hidden', config.lyricsMode === 'block');
  }

  markLanguage();

  const badge = $('nav-badge-tr');
  badge.textContent = T.t(config.transcribeEnabled ? 'app.on' : 'app.off');
  badge.className = config.transcribeEnabled ? 'chip good' : 'chip';

  suppress = false;
}

// ----------------------------------------------------------------- controls

function bindInputs() {
  for (const [id, kind] of Object.entries(INPUTS)) {
    const el = $(id);
    if (!el) continue;

    const commit = () => {
      const raw = kind === 'number' ? Number(el.value) : el.value;
      if (Number.isNaN(raw)) return;
      save({ [id]: raw });
    };

    if (el.type === 'range') {
      el.addEventListener('input', commit);
    } else {
      // Debounced rather than commit-on-blur: closing the window right after
      // typing does not reliably fire `change`, and losing a freshly pasted
      // client id that way is a miserable first-run experience.
      el.addEventListener('input', debounce(commit, 400));
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    }
  }

  for (const token of all('[data-token]')) {
    token.addEventListener('click', () => {
      const field = $('activityName');
      field.value = `${field.value}${token.dataset.token}`;
      save({ activityName: field.value });
    });
  }

  window.addEventListener('pagehide', flushPending);
  window.addEventListener('beforeunload', flushPending);
}

function bindSwitches() {
  for (const row of all('[data-switch]')) {
    const key = row.dataset.switch;

    const knob = document.createElement('button');
    knob.type = 'button';
    knob.className = 'switch';
    knob.setAttribute('role', 'switch');
    knob.innerHTML = '<span class="knob"></span>';
    row.appendChild(knob);

    // The whole row is the target: a 38-pixel switch is a small thing to hit.
    row.addEventListener('click', () => save({ [key]: !config[key] }));
  }
}

function setSwitch(row, on) {
  const knob = row.querySelector('.switch');
  if (knob) knob.setAttribute('aria-checked', on ? 'true' : 'false');
}

function bindSegmented() {
  for (const group of all('[data-seg]')) {
    const key = group.dataset.seg;
    for (const button of all('button', group)) {
      button.addEventListener('click', (event) => {
        const raw = button.dataset.value;
        if (key === 'theme') {
          config.theme = raw;
          applyTheme(raw, event);
          api.config.set({ theme: raw });
          render();
          return;
        }
        save({ [key]: /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw });
      });
    }
  }
}

function bindDisclosures() {
  for (const button of all('[data-more]')) {
    button.addEventListener('click', () => {
      const target = document.querySelector(`[data-collapse="${button.dataset.more}"]`);
      const open = target.classList.toggle('open');
      button.textContent = open ? `${T.t('app.less')} ▴` : `${T.t('app.more')} ▾`;
    });
  }
}

function openSub(key, open) {
  const block = document.querySelector(`[data-sub="${key}"]`);
  if (block) block.classList.toggle('open', Boolean(open));
}

// --------------------------------------------------------------- navigation

function bindNav() {
  for (const item of all('#nav .nav-item')) {
    item.addEventListener('click', () => selectPanel(item.dataset.panel));
  }
}

function selectPanel(name) {
  for (const item of all('#nav .nav-item')) {
    item.setAttribute('aria-selected', item.dataset.panel === name ? 'true' : 'false');
  }
  for (const panel of all('.panel')) {
    panel.hidden = panel.id !== `panel-${name}`;
  }
  // Re-trigger the entry animation, which only runs on a fresh element.
  const shown = $(`panel-${name}`);
  if (shown) {
    shown.style.animation = 'none';
    void shown.offsetWidth;
    shown.style.animation = '';
  }
  $('scroll').scrollTop = 0;
}

function bindSearch() {
  $('search').addEventListener('input', (event) => {
    const needle = event.target.value.trim().toLowerCase();
    let firstMatch = null;

    for (const item of all('#nav .nav-item')) {
      const panel = $(`panel-${item.dataset.panel}`);
      // data-title holds a dictionary key, so the keywords follow the language.
      const keywords = panel?.dataset.title ? T.t(panel.dataset.title) : '';
      const haystack = `${item.textContent} ${keywords}`.toLowerCase();
      const hit = !needle || haystack.includes(needle);
      item.classList.toggle('hidden', !hit);
      if (hit && !firstMatch) firstMatch = item.dataset.panel;
    }

    // Jump to what was found, so typing lands somewhere useful.
    if (needle && firstMatch) selectPanel(firstMatch);
  });
}

// -------------------------------------------------------------------- theme

function applyTheme(choice, event) {
  const resolved =
    choice === 'sys'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : choice;

  document.documentElement.setAttribute('data-theme', resolved);
  $('theme-icon').textContent = resolved === 'light' ? '☀' : '☾';
  $('theme-label').textContent = T.t(resolved === 'light' ? 'app.light' : 'app.dark');

  // Everything cross-fades for 860 ms rather than snapping colour by colour.
  document.documentElement.setAttribute('data-switching', '1');
  setTimeout(() => document.documentElement.removeAttribute('data-switching'), 860);

  if (event) spawnRipple(event, resolved);
}

function spawnRipple(event, theme) {
  const node = document.createElement('div');
  node.className = 'ripple';
  node.style.left = `${event.clientX}px`;
  node.style.top = `${event.clientY}px`;
  node.style.background = `radial-gradient(circle, ${
    theme === 'light' ? 'rgba(255,255,255,.85)' : 'rgba(125,108,246,.7)'
  } 0%, transparent 72%)`;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 900);
}

// ------------------------------------------------------------------ actions

function bindWindowButtons() {
  $('win-min').addEventListener('click', () => api.window.minimise());
  $('win-max').addEventListener('click', () => api.window.toggleMaximise());
  $('win-close').addEventListener('click', () => api.window.close());
  $('theme-toggle').addEventListener('click', (event) => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    config.theme = next;
    applyTheme(next, event);
    api.config.set({ theme: next });
    render();
  });
}

/**
 * The language picker, built from what the agent actually ships.
 *
 * Pills rather than a dropdown: this window has no other dropdown — the design
 * uses segmented controls — and a list that may gain entries wraps better as
 * pills than it fits into a fixed row of segments.
 */
function fillLanguages() {
  const box = $('language');
  box.textContent = '';

  const choices = [...T.languages, { code: 'sys', label: T.t('app.system') }];
  for (const { code, label } of choices) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill';
    pill.dataset.value = code;
    pill.textContent = label;
    pill.setAttribute('role', 'radio');
    pill.addEventListener('click', () => save({ language: code }));
    box.appendChild(pill);
  }
  markLanguage();
}

/** Highlight whichever pill is current. */
function markLanguage() {
  const current = config.language || 'en';
  for (const pill of all('#language .pill')) {
    pill.setAttribute('aria-selected', pill.dataset.value === current ? 'true' : 'false');
  }
}

function bindActions() {
  const reconnect = () => api.actions.reconnectDiscord();
  $('btn-reconnect').addEventListener('click', reconnect);
  $('btn-reconnect2').addEventListener('click', reconnect);

  $('btn-clear-cache').addEventListener('click', () => api.actions.clearLyricsCache());
  $('btn-open-lyrics').addEventListener('click', () => api.actions.openLyricsFolder());
  $('btn-open-logs').addEventListener('click', () => api.actions.openLogFolder());

  $('btn-copy-log').addEventListener('click', () => {
    const text = visibleLog()
      .map((e) => `${e.time} ${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  });

  $('btn-reset').addEventListener('click', async () => {
    await api.config.reset();
    config = await api.config.get();
    render();
  });

  for (const link of all('[data-external]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      api.actions.openExternal(link.dataset.external);
    });
  }

  for (const pill of all('#log-filters .pill')) {
    pill.addEventListener('click', () => {
      logFilter = pill.dataset.level;
      for (const other of all('#log-filters .pill')) {
        other.setAttribute('aria-selected', other === pill ? 'true' : 'false');
      }
      renderLog();
    });
  }
}

// ------------------------------------------------------------------- status

function applyStatus(next) {
  if (!next) return;
  status = next;

  $('foot-version').textContent = next.version || '—';

  const discord = Boolean(next.discordConnected);
  $('foot-discord').className = `dot ${discord ? 'on' : 'off'}`;
  $('foot-discord-text').textContent = discord
    ? (next.discordUser ? T.t('status.discordUser', { user: next.discordUser }) : T.t('status.discord'))
    : T.t('status.discordOff');
  $('nav-dot-conn').className = `dot ${discord ? 'on' : 'off'}`;

  const tabs = next.browserClients || 0;
  $('foot-browser').className = `dot ${tabs ? 'on' : 'off'}`;
  $('foot-browser-text').textContent = tabs
    ? T.t('status.browserTabs', { count: tabs })
    : T.t('status.browserOff');

  const notice = $('notice-discord');
  notice.hidden = discord;
  $('notice-discord-text').textContent = next.lastError || '';

  $('port-chip').textContent = T.t(tabs ? 'status.portReachable' : 'status.portWaiting');
  $('port-chip').className = tabs ? 'chip good' : 'chip';

  renderPreview(next);
  renderTranscription(next.transcription);
}

/**
 * The presence footer.
 *
 * Placeholders stay put until real values arrive — that striped empty state is
 * deliberate, and inventing sample data would make a disconnected agent look
 * like a working one.
 */
function renderPreview(next) {
  const now = next.now;
  const lyric = next.lyrics?.line;

  show('preview-title', 'ph-title', 'tag-title', now?.title);
  show('preview-lyric', 'ph-lyric', 'tag-lyric', lyric);

  const cover = $('preview-cover');
  const src = now?.thumbnail;
  if (src && /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\//.test(src)) {
    if (cover.getAttribute('src') !== src) cover.setAttribute('src', src);
  } else {
    cover.removeAttribute('src');
  }

  const chip = $('preview-chip');
  if (now) {
    chip.classList.remove('hidden');
    $('preview-chip-text').textContent = T.t(
      now.paused ? 'preview.paused' : now.buffering ? 'preview.loading' : 'preview.playing',
    );
  } else {
    chip.classList.add('hidden');
  }

  const position = now?.position ?? 0;
  const duration = now?.duration ?? 0;
  $('preview-elapsed').textContent = duration ? clock(position) : '--:--';
  $('preview-total').textContent = duration ? clock(duration) : '--:--';
  $('preview-fill').style.width = duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
}

function show(textId, placeholderId, tagId, value) {
  const hasValue = Boolean(value);
  $(textId).textContent = value || '';
  $(textId).classList.toggle('hidden', !hasValue);
  $(placeholderId).classList.toggle('hidden', hasValue);
  $(tagId).classList.toggle('hidden', hasValue);
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderTranscription(job) {
  const box = $('transcribe-job');
  const line = $('transcribe-phase');
  const detail = $('transcribe-detail');
  const spinner = $('transcribe-spinner');

  const PHASES = { download: T.t('tr.phaseDownload'), transcribe: T.t('tr.phaseTranscribe') };
  const waiting = job?.queued
    ? `
${T.t('tr.queued', { count: job.queued, names: job.queue.join(', ') })}`
    : '';

  if (job?.phase) {
    box.dataset.busy = '1';
    spinner.hidden = false;
    line.textContent = `${PHASES[job.phase] || job.phase} — ${job.track || ''}`;
    detail.textContent = `${T.t('tr.running', { time: duration(job.elapsed) })}${waiting}`;
    return;
  }

  spinner.hidden = true;
  box.dataset.busy = '0';

  if (job?.waitingFor) {
    line.textContent = T.t('tr.waitingFor', { track: job.waitingFor.track || '…' });
    detail.textContent = T.t('tr.startsIn', { time: duration(job.waitingFor.inSeconds) });
    return;
  }

  line.textContent = job?.halted
    ? T.t('tr.halted', { count: job.consecutiveFailures })
    : T.t('tr.idle');

  const history = (job?.history || [])
    .map((h) =>
      h.outcome === 'ok'
        ? `✓ ${h.label} (${duration(h.seconds)})`
        : `✗ ${h.label} — ${h.detail || T.t('tr.failed')}`,
    )
    .join('\n');
  detail.textContent = [waiting.trim(), history].filter(Boolean).join('\n');
}

function duration(total) {
  const seconds = Math.max(0, Math.round(total || 0));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------- log

function visibleLog() {
  if (logFilter === 'all') return logEntries;
  if (logFilter === 'lyrics') {
    return logEntries.filter((e) => /lyric|transkri|untertitel/i.test(e.message));
  }
  if (logFilter === 'warn') return logEntries.filter((e) => e.level === 'warn' || e.level === 'error');
  return logEntries.filter((e) => e.level === logFilter);
}

function renderLog() {
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

  box.textContent = '';
  for (const entry of visibleLog().slice(-300)) {
    const row = document.createElement('div');
    row.className = `log-row ${entry.level}`;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = String(entry.time || '').slice(11, 19);

    const level = document.createElement('span');
    level.className = 'lvl';
    level.textContent = entry.level;

    const message = document.createElement('span');
    message.className = 'msg';
    message.textContent = entry.message;

    row.append(when, level, message);
    box.appendChild(row);
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ helpers

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
