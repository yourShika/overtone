'use strict';

/**
 * Local bridge between the browser extension and the agent.
 *
 * SECURITY: a WebSocket server on 127.0.0.1 is reachable by *any* page the user
 * visits — localhost is not a trust boundary in the browser. Without a check,
 * any website could push fabricated presence to the user's Discord profile.
 *
 * Browsers set the `Origin` header on WebSocket handshakes and it cannot be
 * forged from page JavaScript, so we accept only extension origins and reject
 * http(s) pages outright. Native clients (which send no Origin at all) are
 * accepted, since they already have local code execution and nothing is gained
 * by blocking them.
 */

const { EventEmitter } = require('node:events');
const { t } = require('./i18n');
const { WebSocketServer } = require('ws');

const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_MESSAGE_BYTES = 64 * 1024;

const ALLOWED_ORIGIN = /^(chrome-extension|moz-extension|extension|safari-web-extension):\/\//i;

/**
 * @fires Bridge#state      (payload, client)
 * @fires Bridge#clear      (payload, client)
 * @fires Bridge#command    (name, payload, client)
 * @fires Bridge#clients    (count)
 */
class Bridge extends EventEmitter {
  /** @param {{ port: number, logger?: object }} options */
  constructor({ port, logger = console }) {
    super();
    this.port = port;
    this.logger = logger;
    this.server = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
    this._heartbeat = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1', // loopback only — never expose this to the network
        port: this.port,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: (info, done) => {
          const origin = info.origin || info.req.headers.origin;

          if (!origin) {
            // No Origin header: not a browser page. Fine.
            done(true);
            return;
          }
          if (ALLOWED_ORIGIN.test(origin)) {
            done(true);
            return;
          }

          this.logger.warn?.(t('msg.bridgeRejected', { origin }));
          done(false, 403, 'Forbidden origin');
        },
      });

      server.on('listening', () => {
        this.server = server;
        this._startHeartbeat();
        this.logger.info?.(t('msg.bridgeListening', { port: this.port }));
        resolve();
      });

      server.on('error', (err) => {
        if (!this.server) reject(err);
        else this.logger.error?.(`[bridge] ${err.message}`);
      });

      server.on('connection', (socket, request) => this._onConnection(socket, request));
    });
  }

  async stop() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;

    for (const socket of this.clients) socket.terminate();
    this.clients.clear();

    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }

  /** Restart on a different port (settings change). */
  async setPort(port) {
    if (port === this.port && this.server) return;
    this.port = port;
    await this.stop();
    await this.start();
  }

  /** Push a status frame to every connected extension. */
  broadcast(type, payload) {
    const message = JSON.stringify({ type, payload, v: PROTOCOL_VERSION });
    for (const socket of this.clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message, (err) => {
          if (err) this.logger.debug?.(`[bridge] Senden fehlgeschlagen: ${err.message}`);
        });
      }
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  // ---------------------------------------------------------------- internals

  _onConnection(socket, request) {
    socket.isAlive = true;
    socket.meta = { origin: request.headers.origin || 'native', name: 'unbekannt' };

    this.clients.add(socket);
    this.emit('clients', this.clients.size);
    this.logger.info?.(t('msg.bridgeClient', { origin: socket.meta.origin }));

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString('utf8'));
      } catch {
        this.logger.debug?.(t('msg.invalidJson'));
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      this._dispatch(message, socket);
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.emit('clients', this.clients.size);
      this.logger.info?.(t('msg.bridgeClientGone'));
      // The last extension leaving means nothing is playing anymore.
      if (!this.clients.size) this.emit('clear', { reason: 'no-clients' }, socket);
    });

    socket.on('error', (err) => {
      this.logger.debug?.(t('msg.bridgeError', { error: err.message }));
    });
  }

  _dispatch(message, socket) {
    switch (message.type) {
      case 'hello':
        socket.meta.name = String(message.payload?.client || 'extension');
        socket.meta.version = String(message.payload?.version || '?');
        this.emit('hello', message.payload || {}, socket);
        return;

      case 'state':
        if (message.payload && typeof message.payload === 'object') {
          this.emit('state', message.payload, socket);
        }
        return;

      case 'clear':
        this.emit('clear', message.payload || {}, socket);
        return;

      case 'watchdog:reloading':
      case 'watchdog:gave-up':
        this.emit('watchdog', message.type, message.payload || {}, socket);
        return;

      case 'command':
        if (typeof message.payload?.name === 'string') {
          this.emit('command', message.payload.name, message.payload.args || {}, socket);
        }
        return;

      default:
        this.logger.debug?.(`[bridge] Unbekannter Nachrichtentyp: ${message.type}`);
    }
  }

  /**
   * Ping/pong liveness check. A browser that is killed (or a laptop that
   * suspends) leaves a half-open socket that never emits 'close', which would
   * otherwise pin a stale presence forever.
   */
  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      for (const socket of this.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this._heartbeat.unref?.();
  }
}

module.exports = { Bridge, PROTOCOL_VERSION };
