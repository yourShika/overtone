'use strict';

/**
 * Minimal Discord IPC client.
 *
 * Speaks the local RPC protocol directly over the named pipe (Windows) or unix
 * socket (macOS/Linux) that the Discord desktop client exposes. No external
 * dependency, because every published wrapper we could use is either abandoned
 * or drags in a native module we do not need.
 *
 * Wire format is a repeated frame of:
 *   [ opcode : uint32 LE ][ length : uint32 LE ][ payload : utf8 JSON ]
 */

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

const OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

const HANDSHAKE_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

/**
 * Candidate socket paths, in probe order. Discord uses discord-ipc-0 normally
 * but increments the suffix when several clients (stable/PTB/Canary) run side
 * by side, so we try a handful.
 */
function socketCandidates() {
  const out = [];

  if (process.platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }

  const base =
    process.env.XDG_RUNTIME_DIR ||
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    '/tmp';

  // Flatpak and Snap relocate the socket into a sandbox subdirectory.
  const prefixes = [
    '',
    'app/com.discordapp.Discord/',
    'app/com.discordapp.DiscordCanary/',
    'snap.discord/',
    'snap.discord-canary/',
  ];

  for (const prefix of prefixes) {
    for (let i = 0; i < 10; i++) {
      out.push(path.join(base, prefix, `discord-ipc-${i}`));
    }
  }
  return out;
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * @fires DiscordIPC#connected  ({ user })      handshake accepted
 * @fires DiscordIPC#disconnected ({ reason })  socket gone, retry scheduled
 * @fires DiscordIPC#error      (Error)
 */
class DiscordIPC extends EventEmitter {
  /** @param {string} clientId Discord application id */
  constructor(clientId) {
    super();
    this.clientId = String(clientId || '');
    this.socket = null;
    this.user = null;
    this.connected = false;

    this._buffer = Buffer.alloc(0);
    this._retryTimer = null;
    this._retryDelay = RECONNECT_MIN_MS;
    this._closedByUs = false;
    this._connecting = false;
  }

  setClientId(clientId) {
    const next = String(clientId || '');
    if (next === this.clientId) return;
    this.clientId = next;
    // The client id is baked into the handshake, so it only takes effect on a
    // fresh connection.
    if (this.connected || this._connecting) this._reconnect('client-id-changed');
  }

  async connect() {
    if (this._connecting || this.connected) return;
    if (!this.clientId) {
      this.emit('error', new Error('Keine Discord Client-ID konfiguriert.'));
      return;
    }

    this._closedByUs = false;
    this._connecting = true;

    let socket = null;
    for (const candidate of socketCandidates()) {
      socket = await openSocket(candidate);
      if (socket) break;
    }

    if (!socket) {
      this._connecting = false;
      this._scheduleRetry('discord-not-running');
      return;
    }

    this.socket = socket;
    this._buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose('socket-closed'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._onClose('socket-error');
    });

    const handshakeTimer = setTimeout(() => {
      if (!this.connected) this._onClose('handshake-timeout');
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
    this._handshakeTimer = handshakeTimer;

    this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    this._connecting = false;
  }

  /**
   * Push an activity to Discord. Pass `null` to clear the presence.
   * @param {object|null} activity
   */
  setActivity(activity) {
    return this._command('SET_ACTIVITY', {
      pid: process.pid,
      activity: activity ?? null,
    });
  }

  clearActivity() {
    return this.setActivity(null);
  }

  destroy() {
    this._closedByUs = true;
    clearTimeout(this._retryTimer);
    clearTimeout(this._handshakeTimer);
    this._retryTimer = null;
    if (this.socket) {
      try {
        this._write(OP.CLOSE, {});
      } catch {
        /* socket already gone */
      }
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.user = null;
  }

  // ---------------------------------------------------------------- internals

  _command(cmd, args) {
    if (!this.connected || !this.socket) return false;
    return this._write(OP.FRAME, { cmd, args, nonce: randomUUID() });
  }

  _write(op, payload) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(encode(op, payload));
      return true;
    } catch (err) {
      this.emit('error', err);
      this._onClose('write-failed');
      return false;
    }
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Frames arrive coalesced or split; drain everything that is complete.
    while (this._buffer.length >= 8) {
      const op = this._buffer.readInt32LE(0);
      const length = this._buffer.readInt32LE(4);
      if (length < 0 || length > 1024 * 1024) {
        this._onClose('bad-frame-length');
        return;
      }
      if (this._buffer.length < 8 + length) break;

      const raw = this._buffer.subarray(8, 8 + length).toString('utf8');
      this._buffer = this._buffer.subarray(8 + length);

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }
      this._onFrame(op, payload);
    }
  }

  _onFrame(op, payload) {
    switch (op) {
      case OP.PING:
        this._write(OP.PONG, payload);
        return;

      case OP.CLOSE:
        this.emit('error', new Error(payload?.message || 'Discord hat die Verbindung geschlossen.'));
        this._onClose('remote-close');
        return;

      case OP.FRAME:
        if (payload?.cmd === 'DISPATCH' && payload?.evt === 'READY') {
          clearTimeout(this._handshakeTimer);
          this.connected = true;
          this._retryDelay = RECONNECT_MIN_MS;
          this.user = payload?.data?.user ?? null;
          this.emit('connected', { user: this.user });
          return;
        }
        if (payload?.evt === 'ERROR') {
          this.emit(
            'error',
            new Error(payload?.data?.message || 'Discord hat den Befehl abgelehnt.'),
          );
        }
        this.emit('frame', payload);
        return;

      default:
        return;
    }
  }

  _onClose(reason) {
    clearTimeout(this._handshakeTimer);
    const wasConnected = this.connected;
    this.connected = false;
    this.user = null;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    if (wasConnected) this.emit('disconnected', { reason });
    if (!this._closedByUs) this._scheduleRetry(reason);
  }

  _reconnect(reason) {
    this._onClose(reason);
  }

  _scheduleRetry(reason) {
    if (this._closedByUs || this._retryTimer) return;
    const delay = this._retryDelay;
    this._retryDelay = Math.min(this._retryDelay * 2, RECONNECT_MAX_MS);
    this.emit('retry', { reason, delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.connect();
    }, delay);
    this._retryTimer.unref?.();
  }
}

/** Resolve to a connected socket, or null when this candidate is not there. */
function openSocket(target) {
  return new Promise((resolve) => {
    // On POSIX an absent socket file is the common case; skip the connect churn.
    if (process.platform !== 'win32' && !fs.existsSync(target)) {
      resolve(null);
      return;
    }

    const socket = net.createConnection({ path: target });
    const settle = (value) => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      resolve(value);
    };
    const onConnect = () => settle(socket);
    const onError = () => {
      socket.destroy();
      settle(null);
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

module.exports = { DiscordIPC, OP };
