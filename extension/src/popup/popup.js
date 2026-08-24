'use strict';

/**
 * Extension popup: whether the bridge is up, what the active tab is playing,
 * and the two settings that belong to the browser side rather than the agent.
 *
 * Everything else lives in the agent's own settings window — duplicating it
 * here would give two places to change the same value and no rule for which
 * one wins.
 */

const $ = (id) => document.getElementById(id);

/**
 * Strings come from the agent with the status, so the popup follows the
 * language chosen in the app rather than keeping a second copy of every
 * sentence. Until the first status arrives, elements stay empty — showing one
 * language and then swapping reads worse than a blank frame.
 */
let strings = {};

function t(key, vars) {
  const template = Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '';
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

function applyStrings() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const text = t(el.dataset.i18n);
    if (text) el.textContent = text;
  }
}

let refreshTimer = null;

init();

async function init() {
  const { port, captions } = await chrome.storage.local.get({ port: 8787, captions: true });

  $('port').value = port;
  $('port').addEventListener('change', (event) => {
    const value = clampPort(Number(event.target.value));
    event.target.value = value;
    chrome.storage.local.set({ port: value });
  });

  const knob = document.createElement('button');
  knob.type = 'button';
  knob.className = 'switch';
  knob.setAttribute('role', 'switch');
  knob.setAttribute('aria-checked', captions ? 'true' : 'false');
  knob.innerHTML = '<span class="knob"></span>';
  $('captions-row').appendChild(knob);

  $('captions-row').addEventListener('click', async () => {
    const next = knob.getAttribute('aria-checked') !== 'true';
    knob.setAttribute('aria-checked', next ? 'true' : 'false');
    await chrome.storage.local.set({ captions: next });
  });

  // Asks the worker to do it: it already tracks the reporting tabs, so this
  // needs no `tabs` permission. The extension holds only `storage` and
  // `alarms`, and keeping it that way is worth a message round-trip.
  $('reload-tabs').addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'popup:reloadTabs' });
    } catch {
      /* worker restarting */
    }
    window.close();
  });

  refresh();
  refreshTimer = setInterval(refresh, 1000);
  window.addEventListener('pagehide', () => clearInterval(refreshTimer));
}

async function refresh() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'popup:status' });
  } catch {
    return; // the service worker is restarting
  }
  if (!status) return;

  if (status.i18n && Object.keys(status.i18n).length) {
    strings = status.i18n;
    applyStrings();
  }
  renderStatus(status);
  renderTab(status.now);
}

function renderStatus(status) {
  const box = $('status');
  const connected = Boolean(status.connected);

  box.dataset.state = connected ? 'on' : 'off';
  $('status-title').textContent = t(connected ? 'popup.connected' : 'popup.disconnected');

  if (connected) {
    const tabs = status.agent?.browserClients;
    $('status-sub').textContent = tabs
      ? t('popup.portTabs', { port: status.port, count: tabs })
      : t('popup.port', { port: status.port });
  } else {
    // Say what to do, not merely that something is wrong.
    $('status-sub').textContent = t('popup.notRunning', { port: status.port });
  }
}

function renderTab(now) {
  fill('tab-title', 'ph-title', now?.title);
  fill('tab-by', 'ph-by', now && (now.artist || now.channel));

  const thumb = $('tab-thumb');
  const art =
    now?.thumbnail || (now?.videoId ? `https://i.ytimg.com/vi/${now.videoId}/mqdefault.jpg` : '');
  thumb.style.backgroundImage = art ? `url("${art}")` : '';
}

/** Placeholders stay until real values arrive; nothing is invented. */
function fill(textId, placeholderId, value) {
  const has = Boolean(value);
  $(textId).textContent = value || '';
  $(textId).classList.toggle('hidden', !has);
  $(placeholderId).classList.toggle('hidden', has);
}

function clampPort(value) {
  if (!Number.isFinite(value)) return 8787;
  return Math.min(65535, Math.max(1024, Math.round(value)));
}
