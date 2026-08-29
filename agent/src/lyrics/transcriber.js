'use strict';

/**
 * Last resort for songs nothing else knows: transcribe the audio locally.
 *
 * Downloads the audio with yt-dlp, runs Whisper over it, writes an .lrc into
 * the library and deletes the audio again. The result lands in the library, so
 * the *next* play has lyrics — transcription is never fast enough to help the
 * play that triggered it, and is not meant to.
 *
 * Two findings shape this, both measured rather than assumed:
 *
 *  - Only the `web_embedded` player client currently yields audio. The default
 *    client returns 403 and several others serve DRM-protected streams, which
 *    this project does not touch.
 *  - Language detection is the weak link, not Whisper. Left to guess on music,
 *    it identified a Polish track as Russian and produced Cyrillic nonsense.
 *    Pinning the language made the same run both twice as fast and actually
 *    readable, so `language` matters far more than `model` here.
 *
 * One job at a time: Whisper saturates every core, and queuing two would make
 * both slow without finishing either sooner.
 */

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { t } = require('../i18n');

const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_QUEUE = 5;

/**
 * Player clients to try, best first.
 *
 * Measured against one video with everything else held equal: `web_embedded`
 * returns format 251, a real audio-only stream at about 129 kbit/s. Every other
 * client returns format 18 — a 360p muxed mp4 carrying thinner audio inside a
 * file several times larger. So the tail of this list is a fallback in the
 * literal sense: a worse transcription is better than none, but only once the
 * good path has actually failed.
 */
const DOWNLOAD_CLIENTS = ['web_embedded', 'tv_simply', 'mweb'];

/**
 * Decide whether another attempt could possibly help.
 *
 * Trying again is free in code and expensive in someone's patience, so the
 * cases where it cannot work are named rather than lumped in. None of these is
 * a defect in Overtone and none has a workaround here — the point is to say so
 * instead of grinding through a list of clients that will all be refused for
 * the same reason.
 *
 * @param {string} message stderr from yt-dlp
 * @returns {'needsSignIn'|'unavailable'|'drm'|'noCookies'|'retryable'}
 */
function classifyDownloadError(message) {
  const text = String(message || '').toLowerCase();

  // The cookie jar itself was unreadable — usually the browser holding its
  // database open. Distinct from having no cookies configured at all.
  if (
    text.includes('could not copy') ||
    text.includes('unable to open') ||
    (text.includes('cookie') && (text.includes('database') || text.includes('locked')))
  ) {
    return 'noCookies';
  }

  // Age or bot checks. Both are answered by being signed in, not by retrying.
  if (
    text.includes('sign in to confirm') ||
    text.includes('age-restricted') ||
    text.includes('age restricted') ||
    text.includes('confirm your age') ||
    text.includes('login required') ||
    text.includes('account associated')
  ) {
    return 'needsSignIn';
  }

  if (text.includes('drm')) return 'drm';

  // Raised by cookieArgs() before yt-dlp is even started.
  if (text.includes('cookies.txt') || text.includes('cookie-datei') || text.includes('cookie file')) {
    return 'cookieFileGone';
  }

  if (
    text.includes('video unavailable') ||
    text.includes('private video') ||
    text.includes('has been removed') ||
    // Deliberately not a bare "is not available": "Requested format is not
    // available" says the opposite of gone — it is the one failure another
    // client is most likely to fix, and swallowing it here would stop the
    // fallback before it started.
    text.includes('video is not available') ||
    text.includes('content is not available') ||
    text.includes('members-only') ||
    text.includes('members only')
  ) {
    return 'unavailable';
  }

  return 'retryable';
}

class Transcriber extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.workDir      scratch space for the audio
   * @param {string} options.libraryDir   where the .lrc is written
   * @param {string} options.script       path to tools/transcribe-to-lrc.py
   * @param {object} [options.logger]
   */
  constructor({ workDir, libraryDir, script, logger = console }) {
    super();
    this.workDir = workDir;
    this.libraryDir = libraryDir;
    this.script = script;
    this.logger = logger;

    /** @type {string|null} video id currently being worked on */
    this.busyWith = null;
    /**
     * What the current job is doing: 'download' | 'transcribe' | null.
     *
     * A job runs for minutes with nothing to show for it until the very end, so
     * the phase is worth reporting — otherwise a working agent and a stuck one
     * look identical.
     */
    this.phase = null;
    /** Epoch ms the current job started, for an elapsed-time readout. */
    this.startedAt = null;
    /** Human-readable name of what is being worked on. */
    this.currentTrack = null;
    /** Finished jobs this session, oldest first, capped. */
    this.history = [];
    /**
     * Tracks waiting their turn.
     *
     * A job outlives the song that triggered it, so anything played meanwhile
     * would otherwise be dropped and never looked at again — the lookup that
     * would have queued it runs once per track.
     * @type {object[]}
     */
    this.queue = [];
    /** Ids already tried this session, successful or not, so we stop retrying. */
    this.attempted = new Set();
    this.lastError = null;
    /** Failures in a row; a broken setup fails every track alike. */
    this.consecutiveFailures = 0;
  }

  get busy() {
    return this.busyWith !== null;
  }

  /**
   * Whether this track is worth starting a job for right now.
   *
   * Stops after a run of failures. When the cause is the setup rather than the
   * song — yt-dlp missing, Python missing, YouTube changing again — every
   * further track fails identically, and retrying each one only buries the real
   * error under noise.
   */
  canStart(videoId) {
    if (!videoId || this.busy || this.attempted.has(videoId)) return false;
    return this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
  }

  /** Clear the failure stop, e.g. after the user fixed a path in settings. */
  resetFailures() {
    this.consecutiveFailures = 0;
    this.emit('change');
  }

  /**
   * Let this track be attempted again.
   *
   * `attempted` exists so a track that failed is not retried every four
   * seconds. Somebody pointing at one file and asking for a fresh transcription
   * is the one case where the repeat is the point, so the halt lifts with it.
   */
  forget(videoId) {
    this.attempted.delete(videoId);
    this.resetFailures();
  }

  /**
   * Take this track now, or remember it for when the current job finishes.
   *
   * 'deferred' and 'skipped' are deliberately different answers. The first is
   * "not now" — the queue is full, or a run of failures has stopped everything
   * — and the caller should keep the track and offer it again later; the second
   * is "never", and holding on to it would only leak. They were one answer
   * once, which is why a track that arrived while the queue was full was
   * dropped as if it had already been transcribed.
   * @returns {'started'|'queued'|'deferred'|'skipped'}
   */
  submit(job) {
    if (!job.videoId) return 'skipped';
    if (this.attempted.has(job.videoId)) return 'skipped';
    if (this.queue.some((item) => item.videoId === job.videoId)) return 'skipped';
    if (this.halted) return 'deferred';

    if (this.busy) {
      if (this.queue.length >= MAX_QUEUE) return 'deferred';
      this.queue.push(job);
      this.emit('change');
      return 'queued';
    }

    this.run(job);
    return 'started';
  }

  _next() {
    const job = this.queue.shift();
    if (!job) return;
    // Config may have changed while it waited, so re-read rather than reuse.
    this.run({ ...job, config: job.getConfig ? job.getConfig() : job.config });
  }

  get halted() {
    return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  /**
   * Download, transcribe, store, clean up.
   *
   * @param {object} job
   * @param {string} job.videoId
   * @param {string} job.url
   * @param {string} [job.artist]
   * @param {string} [job.track]
   * @param {object} job.config
   * @returns {Promise<boolean>} whether an .lrc was written
   */
  async run({ videoId, url, artist = '', track = '', config }) {
    if (!this.canStart(videoId)) return false;

    this.busyWith = videoId;
    this.attempted.add(videoId);
    this.lastError = null;
    this.startedAt = Date.now();
    this.currentTrack = track || videoId;
    this._setPhase('download');

    let audioFile = null;
    try {
      await fs.mkdir(this.workDir, { recursive: true });

      this.logger.info?.(t('msg.trDownload', { track: track || videoId }));
      audioFile = await this._download(videoId, url, config);

      this._setPhase('transcribe');
      this.logger.info?.(t('msg.trWhisper'));
      await this._transcribe({ audioFile, videoId, artist, track, config });

      this.logger.info?.(t('msg.trDone'));
      this.consecutiveFailures = 0;
      this._record(track || videoId, 'ok', null, { videoId, url, artist, track });
      this.emit('done', { videoId });
      return true;
    } catch (err) {
      // Say what to do about it, not just what yt-dlp printed. Its own advice
      // is a paragraph of URLs; the setting it points at is two clicks away in
      // the window the message appears in.
      const kind = classifyDownloadError(err.message);
      const advice = kind === 'retryable' ? null : t(`msg.trWhy.${kind}`);

      this.lastError = advice || err.message;
      this.logger.warn?.(t('msg.trFailed', { error: err.message }));
      if (advice) this.logger.warn?.(advice);

      // Only a fault that better setup could fix counts towards the stop. A
      // run of age-restricted songs says nothing about whether Whisper works,
      // and halting on them would take the feature away for the next track.
      if (kind === 'retryable' || kind === 'noCookies') this.consecutiveFailures += 1;

      if (this.halted) {
        this.logger.warn?.(
          t('msg.trHalted', { count: this.consecutiveFailures }),
        );
      }
      this._record(track || videoId, 'failed', advice || err.message, { videoId, url, artist, track });
      return false;
    } finally {
      // The audio is a means to an end and must not linger, whether the run
      // succeeded, failed or was killed by a timeout.
      if (audioFile) await fs.rm(audioFile, { force: true }).catch(() => {});
      await this._cleanWorkDir();
      this.busyWith = null;
      this.currentTrack = null;
      this.startedAt = null;
      this._setPhase(null);
      // Deliberately after the phase reset, so the display never shows two
      // jobs at once, and only when the setup still looks healthy.
      if (!this.halted) this._next();
    }
  }

  _setPhase(phase) {
    this.phase = phase;
    this.emit('change');
  }

  /**
   * Note how a job ended.
   *
   * The identifiers ride along with the label because a failure is the one
   * entry somebody wants to act on, and "Artist - Title" is not enough to act
   * with: the worker downloads by video id. Without them the window could show
   * that a track failed but not offer to run it again, which is the obvious
   * next thing to want.
   */
  _record(label, outcome, detail, { videoId = null, url = null, artist = '', track = '' } = {}) {
    this.history.push({
      label,
      outcome,
      detail,
      videoId,
      url,
      artist,
      track,
      seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
    });
    if (this.history.length > 20) this.history.shift();
  }

  /** Everything the settings window needs to show what is going on. */
  report() {
    return {
      phase: this.phase,
      videoId: this.busyWith,
      track: this.currentTrack,
      elapsed: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      halted: this.halted,
      consecutiveFailures: this.consecutiveFailures,
      // `retry` rather than leaving the window to work it out: whether a job
      // can be run again is this class's rule — it needs a video id because the
      // worker downloads by id, and it will not start a second job while one is
      // running. The window should render that answer, not re-derive it.
      history: this.history
        .slice(-5)
        .reverse()
        .map((entry) => ({
          ...entry,
          retry: entry.outcome === 'failed' && Boolean(entry.videoId) && !this.busy,
        })),
      attempted: this.attempted.size,
      queued: this.queue.length,
      queue: this.queue.map((item) => item.track || item.videoId),
    };
  }

  /**
   * Fetch the audio, trying the next client when the last one failed for a
   * reason another might not share.
   *
   * The order is not arbitrary. Measured against the same video: web_embedded
   * is the only client that offers a real audio-only stream (format 251, about
   * 129 kbit/s); every other client falls back to format 18, a 360p muxed mp4
   * whose audio is thinner and whose download is several times the size. So the
   * others are a last resort rather than an alternative — worse lyrics beat no
   * lyrics, but only once the good path is genuinely gone.
   */
  async _download(videoId, url, config) {
    let lastError = null;

    for (const client of DOWNLOAD_CLIENTS) {
      try {
        return await this._downloadWith(videoId, url, config, client);
      } catch (err) {
        lastError = err;
        const kind = classifyDownloadError(err.message);

        // Retrying cannot conjure permission, undo a takedown, or break DRM.
        if (kind !== 'retryable') throw err;

        this.logger.debug?.(
          t('msg.trClientFailed', { client, error: lastLine(err.message) }),
        );
      }
    }

    throw lastError;
  }

  async _downloadWith(videoId, url, config, client) {
    const template = path.join(this.workDir, `${videoId}.%(ext)s`);
    const args = [
      '--no-update',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--extractor-args',
      `youtube:player_client=${client}`,
      // Not optional. Without a JS runtime this client exposes no audio-only
      // format at all and the download dies on "Requested format is not
      // available" — which reads like a format problem and is not one.
      ...(config.ytdlpJsRuntime ? ['--js-runtimes', config.ytdlpJsRuntime] : []),
      // Asks as the user rather than as a stranger. The only thing that gets
      // past an age check, and it does so by satisfying it, not by dodging it.
      // The file wins when both are set: someone who exported one did so
      // because reading the browser did not work.
      ...cookieArgs(config),
      // Fall back to a combined stream: Whisper reads it through ffmpeg either
      // way, so a video track is wasteful rather than fatal.
      '-f',
      'bestaudio/best',
      '-o',
      template,
      url || `https://www.youtube.com/watch?v=${videoId}`,
    ];

    await this._spawn(config.ytdlpPath || 'yt-dlp', args, DOWNLOAD_TIMEOUT_MS, 'yt-dlp');

    const files = await fs.readdir(this.workDir);
    const match = files.find((name) => name.startsWith(`${videoId}.`));
    if (!match) throw new Error(t('msg.trNoFile'));
    return path.join(this.workDir, match);
  }

  async _transcribe({ audioFile, videoId, artist, track, config }) {
    const args = [
      this.script,
      audioFile,
      '--video-id',
      videoId,
      '--model',
      config.transcribeModel || 'small',
      '--out',
      this.libraryDir,
      '--title',
      track || '',
      '--artist',
      artist || '',
    ];
    if (config.transcribeLanguage) args.push('--language', config.transcribeLanguage);

    await this._spawn(config.pythonPath || 'python', args, TRANSCRIBE_TIMEOUT_MS, 'Whisper');
  }

  _spawn(command, args, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, args, { windowsHide: true });
      } catch (err) {
        reject(new Error(t('msg.spawnNotStartable', { label, error: err.message })));
        return;
      }

      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.stdout?.resume();

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(t('msg.spawnTimeout', { label })));
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(t('msg.spawnNotFound', { label, command, error: err.message })));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(t('msg.spawnExit', { label, code, detail: lastLine(stderr) })));
      });
    });
  }

  /** Leftovers from a killed run would otherwise accumulate silently. */
  async _cleanWorkDir() {
    try {
      const files = await fs.readdir(this.workDir);
      await Promise.all(
        files.map((name) => fs.rm(path.join(this.workDir, name), { force: true }).catch(() => {})),
      );
    } catch {
      /* directory not created yet */
    }
  }
}

/**
 * How to prove who is asking, if at all.
 *
 * Checked here rather than left to yt-dlp: a missing file makes it die with a
 * Python traceback and a PyInstaller banner, which tells the reader nothing
 * about the setting that caused it.
 */
function cookieArgs(config) {
  const file = String(config.cookiesFile || '').trim();
  if (file) {
    if (!existsSync(file)) throw new Error(t('msg.trWhy.cookieFileGone'));
    return ['--cookies', file];
  }
  if (config.cookiesFromBrowser) {
    return ['--cookies-from-browser', config.cookiesFromBrowser];
  }
  return [];
}

function lastLine(text) {
  const line = String(text).trim().split('\n').filter(Boolean).pop();
  return line ? `: ${line.slice(0, 160)}` : '';
}

module.exports = { Transcriber, classifyDownloadError, DOWNLOAD_CLIENTS };
