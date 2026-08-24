/**
 * Service worker — owns the WebSocket to the local agent.
 *
 * Two jobs:
 *   1. Arbitrate between tabs. Several YouTube tabs can report at once; exactly
 *      one of them should drive the Discord presence.
 *   2. Keep the connection to the agent alive across MV3 worker restarts.
 *
 * MV3 workers are evicted after ~30 s idle. Two things fight that: content
 * scripts ping every 5 s while media plays (each message resets the timer), and
 * an alarm re-arms the socket after an eviction we did not prevent.
 */

const PROTOCOL_VERSION = 1;
const VERSION = chrome.runtime.getManifest().version;

/**
 * Capabilities this build can deliver, announced in the `hello` frame.
 *
 * Version numbers are useless for this: an unpacked extension keeps whatever
 * version string it was loaded with until the user hits reload, so an outdated
 * copy can advertise the same version as the agent while missing half its code.
 * Declaring features explicitly lets the agent say "your extension cannot send
 * subtitles" instead of silently showing nothing.
 */
const FEATURES = ['captions'];

const DEFAULT_PORT = 8787;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_ALARM = 'overtone-keepalive';

/** @type {Map<number, { snapshot: object, at: number }>} tabId -> latest report */
const tabs = new Map();

/** @type {WebSocket|null} */
let socket = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let currentPort = DEFAULT_PORT;

/** Mirrors the agent's status, for the popup. */
let agentStatus = null;
/** id of the tab currently driving the presence */
let activeTabId = null;

// ------------------------------------------------------------------ lifecycle

chrome.runtime.onStartup.addListener(() => boot());
chrome.runtime.onInstalled.addListener(() => boot());

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensureConnected();
});

// Also run on plain worker wake-up (not only install/startup).
boot();

async function boot() {
  const { port, enabled } = await chrome.storage.local.get({
    port: DEFAULT_PORT,
    enabled: true,
  });
  currentPort = port;
  if (enabled) connect();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.port) {
    currentPort = changes.port.newValue || DEFAULT_PORT;
    reconnect('port-changed');
  }
  if (changes.enabled) {
    if (changes.enabled.newValue) connect();
    else disconnect('disabled');
  }
});

// ------------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The watchdog speaks up rarely and only about trouble, so it goes straight
  // through rather than waiting for the next state report.
  if (message?.type === 'watchdog:reloading' || message?.type === 'watchdog:gave-up') {
    send({ type: message.type, payload: { ...message.payload, tabId: sender.tab?.id } });
    sendResponse({ ok: true });
    return true;
  }

  // Popup queries.
  if (message?.type === 'popup:status') {
    sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      port: currentPort,
      agent: agentStatus,
      now: activeSnapshot(),
    });
    return true;
  }

  if (message?.type === 'popup:command') {
    sendCommand(message.name, message.args);
    sendResponse({ ok: true });
    return true;
  }

  // Reload from here rather than from the popup: the worker already knows which
  // tabs are reporting, so this needs no `tabs` permission to find them. The
  // extension holds only `storage` and `alarms`, and that is worth keeping.
  if (message?.type === 'popup:reloadTabs') {
    let count = 0;
    for (const id of tabs.keys()) {
      try {
        chrome.tabs.reload(id);
        count += 1;
      } catch {
        /* the tab closed between listing and reloading */
      }
    }
    sendResponse({ ok: true, count });
    return true;
  }

  // Content script reports.
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return false;

  if (message?.type === 'state') {
    tabs.set(tabId, { snapshot: message.payload, at: Date.now() });
    publish();
  } else if (message?.type === 'clear') {
    tabs.delete(tabId);
    publish();
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.delete(tabId)) publish();
});

// -------------------------------------------------------------- tab selection

/**
 * Pick the tab that should drive the presence.
 *
 * Playing beats paused — otherwise a forgotten paused tab in the background
 * would hijack the presence from the video you are actually watching. Among
 * equals, the most recent report wins.
 */
function activeSnapshot() {
  let best = null;
  let bestTabId = null;

  for (const [tabId, entry] of tabs) {
    // Drop reports from tabs that went quiet (crashed, discarded, suspended).
    if (Date.now() - entry.at > 30000) {
      tabs.delete(tabId);
      continue;
    }

    if (!best) {
      best = entry;
      bestTabId = tabId;
      continue;
    }

    const candidateWins =
      (!entry.snapshot.paused && best.snapshot.paused) ||
      (entry.snapshot.paused === best.snapshot.paused && entry.at > best.at);

    if (candidateWins) {
      best = entry;
      bestTabId = tabId;
    }
  }

  activeTabId = bestTabId;
  return best?.snapshot ?? null;
}

let lastPublished = null;

function publish() {
  const snapshot = activeSnapshot();

  if (!snapshot) {
    if (lastPublished !== null) {
      lastPublished = null;
      send({ type: 'clear', payload: { reason: 'no-active-tab' } });
    }
    updateBadge(null);
    return;
  }

  lastPublished = snapshot;
  send({ type: 'state', payload: snapshot });
  updateBadge(snapshot);
}

function updateBadge(snapshot) {
  const connected = socket?.readyState === WebSocket.OPEN;

  let text = '';
  let color = '#7b6cf6';

  if (snapshot && connected) text = snapshot.paused ? '❚❚' : '▶';
  else if (snapshot && !connected) {
    text = '!';
    color = '#ed4245';
  }

  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// ------------------------------------------------------------------- socket

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  try {
    socket = new WebSocket(`ws://127.0.0.1:${currentPort}`);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    send({ type: 'hello', payload: { client: 'extension', version: VERSION, features: FEATURES } });
    // Re-announce whatever is playing; the agent has no memory across restarts.
    publish();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'status') {
      agentStatus = message.payload;
      updateBadge(activeSnapshot());
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    agentStatus = null;
    updateBadge(activeSnapshot());
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' always follows; retry logic lives there.
  });
}

function disconnect(reason) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.close(1000, reason);
    socket = null;
  }
  agentStatus = null;
  updateBadge(null);
}

function reconnect(reason) {
  disconnect(reason);
  connect();
}

function ensureConnected() {
  chrome.storage.local.get({ enabled: true }).then(({ enabled }) => {
    if (enabled && socket?.readyState !== WebSocket.OPEN) connect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ ...message, v: PROTOCOL_VERSION }));
    return true;
  } catch {
    return false;
  }
}

function sendCommand(name, args) {
  send({ type: 'command', payload: { name, args: args || {} } });
}
