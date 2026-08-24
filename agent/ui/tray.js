'use strict';

/**
 * Tray popup.
 *
 * A small window anchored to the tray icon rather than a native menu, because a
 * native menu cannot show artwork, a progress bar or the current lyric. It
 * hides on blur, so it still behaves like a menu.
 */

const api = window.overtone;
const $ = (id) => document.getElementById(id);

let config = {};

init().catch((err) => console.error(err));

async function init() {
  config = await api.config.get();
  await T.init(() => renderConfig());
  document.documentElement.setAttribute('data-theme', resolveTheme(config.theme));

  const privacy = document.createElement('button');
  privacy.type = 'button';
  privacy.className = 'switch small';
  privacy.setAttribute('role', 'switch');
  privacy.innerHTML = '<span class="knob"></span>';
  $('pop-privacy').appendChild(privacy);

  $('pop-privacy').addEventListener('click', () => {
    config.privacyMode = !config.privacyMode;
    api.config.set({ privacyMode: config.privacyMode });
    renderConfig();
  });

  $('pop-pause').addEventListener('click', () => {
    config.enabled = !config.enabled;
    api.config.set({ enabled: config.enabled });
    renderConfig();
  });

  $('pop-settings').addEventListener('click', () => api.tray.openSettings());
  $('pop-quit').addEventListener('click', () => api.tray.quit());

  // Reopening the popup must show current values, not those from first launch.
  api.tray.onShow(async () => {
    config = await api.config.get();
    renderConfig();
  });

  renderConfig();
  applyStatus(await api.status.get());
  api.status.onUpdate(applyStatus);

  fitWindow();
  // The lyric line wraps or disappears as songs change, so the height is not
  // fixed once. Re-measuring on every mutation keeps the window on the content
  // rather than leaving transparent dead space below it.
  new ResizeObserver(fitWindow).observe(document.querySelector('.pop'));
}

let lastHeight = 0;

/** Ask the window to be exactly as tall as what is in it. */
function fitWindow() {
  const height = Math.ceil(document.querySelector('.pop').getBoundingClientRect().height) + 20;
  if (height === lastHeight) return;
  lastHeight = height;
  api.tray.resize(height);
}

function resolveTheme(choice) {
  if (choice === 'sys' || !choice) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return choice;
}

function renderConfig() {
  $('pop-pause-label').textContent = T.t(config.enabled ? 'tray.pause' : 'tray.resume');
  $('pop-privacy')
    .querySelector('.switch')
    .setAttribute('aria-checked', config.privacyMode ? 'true' : 'false');

  const chip = $('pop-state');
  chip.className = config.enabled ? 'chip good' : 'chip';
  chip.querySelector('.dot').className = config.enabled ? 'dot on' : 'dot';
  $('pop-state-text').textContent = T.t(config.enabled ? 'tray.active' : 'tray.paused');
}

function applyStatus(next) {
  if (!next) return;
  const now = next.now;

  fill('pop-title', 'pop-ph-title', now?.title);
  fill('pop-by', 'pop-ph-by', now?.artist || now?.channel);
  fill('pop-lyric', 'pop-ph-lyric', next.lyrics?.line);

  const cover = $('pop-cover');
  const src = now?.thumbnail;
  if (src && /^https:\/\/(i\.ytimg\.com|lh3\.googleusercontent\.com)\//.test(src)) {
    if (cover.getAttribute('src') !== src) cover.setAttribute('src', src);
  } else {
    cover.removeAttribute('src');
  }

  const position = now?.position ?? 0;
  const duration = now?.duration ?? 0;
  $('pop-fill').style.width = duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
}

/** Placeholders stay until real values arrive; nothing is invented. */
function fill(textId, placeholderId, value) {
  const has = Boolean(value);
  $(textId).textContent = value || '';
  $(textId).classList.toggle('hidden', !has);
  $(placeholderId).classList.toggle('hidden', has);
}
