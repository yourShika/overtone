# Configuration and development

Everything the README leaves out, because most people never need it.

Settings live in the tray app's settings window. The file behind it is
`%APPDATA%\Overtone\config.json` — editing it by hand works, but the window is
easier and validates what you type.

---

## The activity header

The line Discord prints as *Listening to …* is a prefix plus a name.

`activityType` chooses the prefix:

| Value | Prefix |
|---|---|
| `auto` | video → `Watching …`, music → `Listening to …` |
| `listening` | `Listening to …` |
| `watching` | `Watching …` |
| `playing` | `Playing …` |

Discord normally fills the name with your application's name, which is why it
would read the same for every song. RPC does accept an explicit name and the
desktop client renders it, so `activityName` is a template:

```
{artist} - {title}    ->    Listening to doli, szevczor, yokinashi - 162020
```

Placeholders: `{artist}`, `{title}`, `{channel}`. Multiple artists are
normalised to the comma form Spotify uses — `doli x szevczor x yokinashi`
becomes `doli, szevczor, yokinashi`. Leave the template empty to fall back to
the application name. It is skipped in privacy mode, so the header cannot give
away what the rest of the presence is hiding.

---

## All settings

### Connection

| Setting | Default | Meaning |
|---|---|---|
| `clientId` | – | Discord Application ID |
| `port` | `8787` | Local port the extension connects to |

### Appearance

| Setting | Default | Meaning |
|---|---|---|
| `activityType` | `auto` | Header prefix |
| `activityName` | `{artist} - {title}` | Header name; empty = application name |
| `showTimestamps` | `true` | Progress bar |
| `showButton` | `true` | Button to the video |
| `buttonLabel` | – | Custom button text |
| `showChannelButton` | `false` | Second button to the channel |
| `channelButtonLabel` | `Kanal öffnen` | Text on that second button |
| `showStateBadge` | `true` | Corner icon for playing/paused/loop/live |
| `stateIconBase` | repo URL | Where those icons are served from |
| `showWhenBrowsing` | `true` | Presence while browsing YouTube |
| `hideWhenPaused` | `false` | Hide the presence when paused |
| `privacyMode` | `false` | Hide title and artwork |
| `highResArtwork` | `true` | `maxresdefault` instead of `hqdefault` |

Three optional keys point at art you uploaded yourself, under **Rich Presence →
Art Assets** in the developer portal. Set, they win over the icons Overtone
ships, and render without a trip through Discord's image proxy.

| Setting | Default | Meaning |
|---|---|---|
| `fallbackAssetKey` | – | Large image when no artwork could be resolved |
| `sourceAssetKey` | – | Corner badge while playing |
| `pausedAssetKey` | – | Corner badge while paused |

### Lyrics

| Setting | Default | Meaning |
|---|---|---|
| `lyricsEnabled` | `true` | Lyric line in the presence |
| `lyricsSource` | `auto` | `auto`, `lrclib`, `captions` |
| `lyricsMusicOnly` | `false` | Only on YouTube Music |
| `lyricsProminent` | `false` | Lyric on the first, bold line |
| `lyricsCombine` | `1` | Merge strength: `0` off, `1`, `1.5`, `2` |
| `lyricsSave` | `true` | Save found lyrics as `.lrc` files |
| `lyricsOffset` | `0` | Manual trim in seconds, for skewed files |

Saved lyrics live in `%APPDATA%\Overtone\lyrics`. A file you have edited is
never overwritten and outranks every other source — being able to correct one
is the point.

### Local transcription

| Setting | Default | Meaning |
|---|---|---|
| `transcribeEnabled` | `false` | Transcribe songs nothing else covers |
| `transcribeLanguage` | – | Pin the language, e.g. `pl`; empty detects |
| `transcribeModel` | `medium` | `tiny`, `base`, `small`, `medium` |
| `transcribeEvenWithCaptions` | `false` | Transcribe even when subtitles exist |
| `transcribeMaxMinutes` | `7` | Skip anything longer; 0 disables the limit |
| `transcribeAfterSeconds` | `45` | Listen this long before starting a job |
| `pythonPath` | `python` | Python interpreter |
| `ytdlpPath` | `yt-dlp` | yt-dlp executable |
| `ytdlpJsRuntime` | `node` | JS runtime yt-dlp needs; empty to leave it alone |

Requires `yt-dlp`, `ffmpeg`, Python with `stable-ts`, and a JavaScript runtime
for yt-dlp. That last one is not optional: without it the embedded player
client offers no audio-only format and the download fails with *"Requested
format is not available"*, which reads like a format problem and is not one.

Two things decided quality here, both measured rather than assumed:

**Language detection is the weak link, not Whisper.** On a Polish track, letting
it guess produced fluent Russian nonsense in 125 s; pinning `pl` gave readable
Polish in 52 s — faster *and* correct. `medium` detects languages far better,
which is why it is the default, but it is not immune: on the same track it also
chose Russian and fell into a repetition loop, emitting one phrase eleven times
for the whole song.

**So bad output is rejected rather than filed.** A wrong `.lrc` is worse than
none: it silently outranks every other source and looks deliberate. Overtone
refuses results that repeat one line throughout or come from a language guess it
is not confident about — while leaving genuine choruses alone.

### Recovery and system

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off clears the presence entirely |
| `watchdogEnabled` | `true` | Reload a wedged YouTube tab |
| `autoStart` | `false` | Start with Windows |
| `startMinimised` | `true` | Start without the settings window |

---

## Development

```bash
npm install                # also generates the icons
npm start                  # run the agent from source
npm test                   # unit tests
npm run test:integration   # hits the live LRCLIB API
python agent/test/quality.test.py   # transcription quality guard
npm run build              # installer + portable exe into dist/
```

The build config lives in `agent/electron-builder.config.js` rather than in
`package.json`, because npm workspaces hoist `electron` into the root
`node_modules` where electron-builder cannot find its version.

How the pieces fit together: [`ARCHITECTURE.md`](ARCHITECTURE.md).
The extension-to-agent protocol: [`PROTOCOL.md`](PROTOCOL.md).
