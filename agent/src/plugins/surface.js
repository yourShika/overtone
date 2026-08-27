'use strict';

/**
 * Serves a surface plugin's page to whatever opens it, and pushes it the song.
 *
 * Separate from bridge.js on purpose. That one is a bare WebSocketServer with
 * no HTTP server to attach to, it starts at boot for everybody, and restarting
 * it on a port change would tear down OBS's page along with it. This one opens
 * with the first enabled surface and closes with the last, so the switch in the
 * panel means something.
 *
 * The address is the credential. There is no login here and no session: a
 * random token sits in the path, and anything that cannot produce it gets a
 * 404. That is stated plainly in the panel rather than dressed up, because the
 * URL ends up pasted into an OBS scene file in plain text.
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { t } = require('../i18n');

/** OBS opens one page per source; a handful covers every real scene. */
const MAX_CLIENTS = 8;
const MAX_CONNECTIONS = 12;

/** A slow or wedged reader must not become a memory leak. */
const MAX_BUFFERED = 1 << 20;

/** Files a surface may serve, and what they are. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

class SurfaceServer {
  /**
   * @param {object} options
   * @param {object} options.registry  PluginRegistry, for what is enabled
   * @param {() => object|null} options.payload  builds the current feed object
   * @param {object} [options.logger]
   */
  constructor({ registry, payload, logger = console }) {
    this.registry = registry;
    this.payload = payload;
    this.logger = logger;

    this.server = null;
    this.port = 0;
    this.token = '';
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    this.last = null;
    this.error = null;
  }

  get running() {
    return this.server !== null;
  }

  /** The address to paste into OBS, or '' when nothing is listening. */
  addressFor(id) {
    return this.running ? `http://127.0.0.1:${this.port}/s/${this.token}/${id}/` : '';
  }

  /**
   * Open the door, if any surface wants it open.
   *
   * Called on every change to the plugin list rather than once: enabling the
   * first surface starts it, disabling the last stops it, and a port change is
   * a stop followed by a start.
   */
  async sync(port) {
    const wanted = this.registry.surfaces().length > 0;

    if (!wanted) {
      await this.stop();
      return;
    }
    if (this.running && this.port === port) return;

    await this.stop();
    await this.start(port);
  }

  async start(port) {
    // New every time it opens. Whoever had the old address does not keep it.
    this.token = crypto.randomBytes(24).toString('base64url');
    this.error = null;

    const server = http.createServer((req, res) => this._handle(req, res));
    server.maxConnections = MAX_CONNECTIONS;
    // Explicit rather than inherited: a socket that never finishes its headers
    // otherwise sits there until Node's defaults decide, which they may change.
    server.headersTimeout = 10_000;
    server.requestTimeout = 20_000;
    server.keepAliveTimeout = 65_000;

    await new Promise((resolve) => {
      server.once('error', (err) => {
        // Never quietly pick another number. A moved port is a Browser Source
        // showing nothing with no visible cause.
        this.error = err.message;
        this.logger.error?.(t('msg.plugServerFailed', { port, error: err.message }));
        this.server = null;
        resolve();
      });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        // Asked for, versus actually bound. They differ when the port is 0, and
        // both the address handed to OBS and the Host check compare against
        // this — so remembering what we asked for would refuse every request.
        this.port = server.address().port;
        this.logger.info?.(t('msg.plugServerUp', { port: this.port }));
        resolve();
      });
    });
  }

  async stop() {
    if (!this.server) return;

    for (const res of this.clients) res.end();
    this.clients.clear();

    const server = this.server;
    this.server = null;
    this.last = null;

    // close() waits for open sockets, and a feed is a socket that is meant to
    // stay open — without this, quitting the app would hang for as long as OBS
    // kept the page up, which is to say indefinitely.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    this.logger.info?.(t('msg.plugServerDown'));
  }

  /**
   * Send the current state to every open page.
   *
   * Called from the tail of refreshUi(), which fires several times a second, so
   * the first thing it does is leave when nobody is listening.
   */
  publish() {
    if (!this.clients.size) return;

    const next = this.payload();
    if (!next) return;

    const { changed } = require('./feed');
    if (!changed(this.last, next)) return;
    this.last = next;

    const frame = `data: ${JSON.stringify(next)}\n\n`;
    for (const res of this.clients) {
      // A reader that stopped reading must not become a growing buffer.
      if (res.writableLength > MAX_BUFFERED) {
        this.clients.delete(res);
        res.destroy();
        continue;
      }
      res.write(frame);
    }
  }

  // ------------------------------------------------------------- requests

  async _handle(req, res) {
    try {
      await this._route(req, res);
    } catch (err) {
      // Anything unhandled here would otherwise reach an http listener in a
      // process with nothing above it, and take the tray agent down.
      this.logger.debug?.(t('msg.plugRejected', { reason: err.message }));
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  }

  async _route(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'method');

    // The DNS-rebinding fix, and what makes "only works on this computer" true
    // rather than hopeful: a page on the internet can resolve a name to
    // 127.0.0.1, but it cannot make the browser send this Host header.
    if (req.headers.host !== `127.0.0.1:${this.port}`) {
      return refuse(res, 403, `host ${req.headers.host}`);
    }

    // Absent Origin is a top-level navigation, which is how OBS opens it. A
    // present one that is not ours is a page trying its luck. Same shape as
    // bridge.js's verifyClient, for the same reason.
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${this.port}`) {
      return refuse(res, 403, `origin ${origin}`);
    }

    // Parsed, never split on '/': a %2e%2e in the path would survive splitting
    // and mean something else entirely by the time it reached the filesystem.
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);

    if (parts[0] !== 's') return refuse(res, 404, 'path');
    if (!this._tokenOk(parts[1])) return refuse(res, 404, 'token');

    const id = parts[2] || '';
    const plugin = this.registry.surfaces().find((p) => p.id === id);
    if (!plugin) return refuse(res, 404, 'not an enabled surface');

    const rest = parts.slice(3);
    if (rest[0] === 'feed') return this._feed(req, res);

    return this._file(req, res, id, rest);
  }

  /**
   * Compare the token without leaking its length or its contents by timing.
   *
   * The length check comes first and is not optional: timingSafeEqual throws
   * RangeError on buffers of different sizes, and one <img src="…/s/a/"> from
   * any page the user happens to visit would otherwise reach that throw.
   */
  _tokenOk(given) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _feed(req, res) {
    if (this.clients.size >= MAX_CLIENTS) return refuse(res, 503, 'too many pages');

    res.writeHead(200, {
      ...COMMON_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    // A first frame straight away, so a page that opens mid-song is not blank
    // until the next change.
    const current = this.payload();
    if (current) res.write(`data: ${JSON.stringify(current)}\n\n`);

    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  async _file(req, res, id, rest) {
    const dir = this.registry.dirFor(id);
    if (!dir) return refuse(res, 404, 'no folder');

    const name = rest.length ? rest.join('/') : 'index.html';
    // An explicit shape rather than a sanitiser: one segment, a known
    // extension, no separators. Nothing here is joined from user input twice.
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) {
      return refuse(res, 404, 'name');
    }

    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type) return refuse(res, 404, 'type');

    const file = path.join(dir, 'public', name);
    // realpath, so a symlink under public/ pointing at somebody's documents
    // resolves before it is opened rather than after.
    let real;
    try {
      real = await fsp.realpath(file);
    } catch {
      return refuse(res, 404, 'missing');
    }
    const root = await fsp.realpath(path.join(dir, 'public'));
    if (real !== root && !real.startsWith(root + path.sep)) {
      return refuse(res, 404, 'outside public');
    }

    const body = await fsp.readFile(real);
    res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': body.length });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }
}

/**
 * On every response, including the refusals.
 *
 * No Access-Control-Allow-Origin anywhere, deliberately: nothing should be able
 * to read this from a page. The referrer policy matters more than it looks —
 * the token is in the path, and the overlay loads artwork from i.ytimg.com.
 */
const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https://i.ytimg.com https://lh3.googleusercontent.com data:; " +
    "font-src 'self'; connect-src 'self'",
};

function refuse(res, code, reason) {
  res.writeHead(code, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  // The reason goes in the log, not to the caller: telling a prober which check
  // it failed is telling it what to fix.
  res.end(code === 404 ? 'Not found\n' : 'Refused\n');
  return reason;
}

module.exports = { SurfaceServer, TYPES, MAX_CLIENTS };
