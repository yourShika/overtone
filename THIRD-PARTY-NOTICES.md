# Third-party notices

Overtone itself is covered by [`LICENSE`](LICENSE). The components below are
not: each keeps its own license, and those licenses permit the redistribution
that Overtone's own license withholds.

| Component | Used for | License |
|---|---|---|
| [Electron](https://github.com/electron/electron) | The desktop app and its window | MIT |
| [ws](https://github.com/websockets/ws) | The local bridge to the browser extension | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | Building the installer (build-time only) | MIT |

Electron bundles Chromium and Node.js, which carry their own licenses. The full
texts ship inside the installed application, under `LICENSES.chromium.html` and
`LICENSE.electron.txt`.

## Optional, not bundled

Local transcription runs these if you switch it on. They are never installed by
Overtone and are not part of any build:

| Component | License |
|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1 or later |
| [stable-ts](https://github.com/jianfch/stable-ts) | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT |
| [OpenAI Whisper models](https://github.com/openai/whisper) | MIT |

## Services

[LRCLIB](https://lrclib.net) provides synced lyrics over a free public API. It
is queried at runtime and needs no key.
