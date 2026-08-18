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
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRANSCRIBE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

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

      this.logger.info?.(`Transkription: lade Audio für "${track || videoId}" …`);
      audioFile = await this._download(videoId, url, config);

      this._setPhase('transcribe');
      this.logger.info?.('Transkription: Whisper läuft (dauert etwa ein Drittel der Songlänge) …');
      await this._transcribe({ audioFile, videoId, artist, track, config });

      this.logger.info?.('Transkription fertig — beim nächsten Hören sind die Lyrics da.');
      this.consecutiveFailures = 0;
      this._record(track || videoId, 'ok', null);
      this.emit('done', { videoId });
      return true;
    } catch (err) {
      this.lastError = err.message;
      this.logger.warn?.(`Transkription fehlgeschlagen: ${err.message}`);
      this.consecutiveFailures += 1;
      if (this.halted) {
        this.logger.warn?.(
          `Transkription pausiert nach ${this.consecutiveFailures} Fehlschlägen in Folge — ` +
            'sieht nach einem Einrichtungsproblem aus, nicht nach dem Song.',
        );
      }
      this._record(track || videoId, 'failed', err.message);
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
    }
  }

  _setPhase(phase) {
    this.phase = phase;
    this.emit('change');
  }

  _record(label, outcome, detail) {
    this.history.push({
      label,
      outcome,
      detail,
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
      history: this.history.slice(-5).reverse(),
      attempted: this.attempted.size,
    };
  }

  async _download(videoId, url, config) {
    const template = path.join(this.workDir, `${videoId}.%(ext)s`);
    const args = [
      '--no-update',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      // Measured: the default client 403s, this one delivers.
      '--extractor-args',
      'youtube:player_client=web_embedded',
      // Not optional. Without a JS runtime this client exposes no audio-only
      // format at all and the download dies on "Requested format is not
      // available" — which reads like a format problem and is not one.
      ...(config.ytdlpJsRuntime ? ['--js-runtimes', config.ytdlpJsRuntime] : []),
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
    if (!match) throw new Error('yt-dlp lieferte keine Datei');
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
        reject(new Error(`${label} nicht startbar: ${err.message}`));
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
        reject(new Error(`${label} überschritt das Zeitlimit`));
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`${label} nicht gefunden (${command}): ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${label} endete mit Code ${code}${lastLine(stderr)}`));
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

function lastLine(text) {
  const line = String(text).trim().split('\n').filter(Boolean).pop();
  return line ? `: ${line.slice(0, 160)}` : '';
}

module.exports = { Transcriber };
