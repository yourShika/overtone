'use strict';

/**
 * Popup: status at a glance plus the two settings that live on the browser side
 * (master switch and bridge port). Everything else belongs to the agent, so the
 * "Einstellungen" button just asks it to raise its own window.
 */

const $ = (id) => document.getElementById(id);

let refreshTimer = null;

init();

async function init() {
  const { enabled, port, autoReload } = await chrome.storage.local.get({
    enabled: true,
    port: 8787,
    autoReload: true,
  });
  $('enabled').checked = enabled;
  $('port').value = port;

  $('autoReload').checked = autoReload;
  $('autoReload').addEventListener('change', (event) => {
    chrome.storage.local.set({ autoReload: event.target.checked });
  });

  $('enabled').addEventListener('change', (event) => {
    chrome.storage.local.set({ enabled: event.target.checked });
    refresh();
  });

  $('port').addEventListener('change', (event) => {
    const port = clampPort(Number(event.target.value));
    event.target.value = port;
    chrome.storage.local.set({ port });
  });

  $('open-settings').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup:command', name: 'openSettings' });
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
    return; // worker restarting
  }
  if (!status) return;

  $('dot').classList.toggle('on', Boolean(status.connected));
  renderTrack(status);
  renderStatusLine(status);
}

function renderTrack(status) {
  const now = status.now;

  $('track').classList.toggle('hidden', !now);
  $('empty').classList.toggle('hidden', Boolean(now));
  if (!now) return;

  $('title').textContent = now.title || '—';
  $('sub').textContent = [now.paused ? '⏸ Pausiert' : '▶ Läuft', now.artist || now.channel]
    .filter(Boolean)
    .join(' · ');

  const lyric = status.agent?.lyrics?.line;
  $('lyric').textContent = lyric ? `♪ ${lyric}` : '';

  const art = now.thumbnail || (now.videoId ? `https://i.ytimg.com/vi/${now.videoId}/mqdefault.jpg` : '');
  if (art && $('art').src !== art) $('art').src = art;
}

function renderStatusLine(status) {
  const el = $('status-line');

  if (!$('enabled').checked) {
    el.textContent = 'Deaktiviert.';
    return;
  }
  if (!status.connected) {
    el.textContent = `Agent nicht erreichbar (Port ${status.port}). Läuft Overtone?`;
    return;
  }

  const agent = status.agent;
  if (!agent) {
    el.textContent = 'Mit Agent verbunden.';
    return;
  }
  if (!agent.discordConnected) {
    el.textContent = 'Agent läuft — wartet auf Discord.';
    return;
  }

  const who = agent.discordUser ? ` als @${agent.discordUser}` : '';
  const lyrics = { loading: ' · Lyrics werden gesucht', none: ' · keine Lyrics', found: ' · Lyrics aktiv' }[
    agent.lyrics?.status
  ] ?? '';

  el.textContent = `Verbunden${who}${lyrics}`;
}

function clampPort(value) {
  if (!Number.isFinite(value)) return 8787;
  return Math.min(65535, Math.max(1024, Math.round(value)));
}
