'use strict';

/**
 * Preload bridge for the settings window.
 *
 * The renderer runs sandboxed with context isolation, so this is the only
 * surface it gets. Every channel is enumerated explicitly — no generic
 * `invoke(channel, ...)` passthrough, which would hand the renderer the whole
 * main process if it were ever compromised.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap a main->renderer channel so callers get an unsubscribe function. */
function subscribe(channel) {
  return (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('overtone', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    reset: () => ipcRenderer.invoke('config:reset'),
  },
  status: {
    get: () => ipcRenderer.invoke('status:get'),
    onUpdate: subscribe('status:update'),
  },
  log: {
    history: () => ipcRenderer.invoke('log:history'),
    onEntry: subscribe('log:entry'),
  },
  actions: {
    clearLyricsCache: () => ipcRenderer.invoke('lyrics:clearCache'),
    reconnectDiscord: () => ipcRenderer.invoke('discord:reconnect'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openLyricsFolder: () => ipcRenderer.invoke('app:openLyricsFolder'),
    openLogFolder: () => ipcRenderer.invoke('app:openLogFolder'),
    extensionPath: () => ipcRenderer.invoke('app:extensionPath'),
    pickCookiesFile: () => ipcRenderer.invoke('app:pickCookiesFile'),
    showExtensionFolder: () => ipcRenderer.invoke('app:showExtensionFolder'),
  },
  i18n: {
    get: () => ipcRenderer.invoke('i18n:get'),
    onChange: subscribe('i18n:changed'),
  },
  // The .lrc files in %APPDATA%/Overtone/lyrics. Named after its channels, the
  // way config/status/log/tray/window are — `actions` is the grab bag, and a
  // set of operations on one thing is not that.
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    read: (name) => ipcRenderer.invoke('library:read', name),
    write: (name, text) => ipcRenderer.invoke('library:write', name, text),
    remove: (name) => ipcRenderer.invoke('library:remove', name),
    reveal: (name) => ipcRenderer.invoke('library:reveal', name),
    regenerate: (name) => ipcRenderer.invoke('library:regenerate', name),
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    reload: () => ipcRenderer.invoke('plugins:reload'),
    setEnabled: (id, on) => ipcRenderer.invoke('plugins:setEnabled', id, on),
    setSetting: (id, key, value) => ipcRenderer.invoke('plugins:setSetting', id, key, value),
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
    examples: () => ipcRenderer.invoke('plugins:examples'),
    addExample: (id) => ipcRenderer.invoke('plugins:addExample', id),
    reveal: (id) => ipcRenderer.invoke('plugins:reveal', id),
    surface: () => ipcRenderer.invoke('plugins:surface'),
    newAddress: () => ipcRenderer.invoke('plugins:newAddress'),
  },
  wizard: {
    finish: () => ipcRenderer.invoke('wizard:finish'),
  },
  tray: {
    openSettings: () => ipcRenderer.invoke('tray:openSettings'),
    quit: () => ipcRenderer.invoke('tray:quit'),
    onShow: subscribe('tray:show'),
    resize: (height) => ipcRenderer.invoke('tray:resize', height),
  },
  // The window is frameless, so its buttons are ours to implement.
  window: {
    minimise: () => ipcRenderer.invoke('window:minimise'),
    toggleMaximise: () => ipcRenderer.invoke('window:toggleMaximise'),
    close: () => ipcRenderer.invoke('window:close'),
  },
});
