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
    showExtensionFolder: () => ipcRenderer.invoke('app:showExtensionFolder'),
  },
  i18n: {
    get: () => ipcRenderer.invoke('i18n:get'),
    onChange: subscribe('i18n:changed'),
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
