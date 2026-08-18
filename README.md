# Overtone

**Discord Rich Presence for YouTube and YouTube Music, with time-synced lyrics.**

Shows what you are watching or listening to on your Discord profile: the title,
the channel or artist, the video thumbnail as cover art, a real progress bar
with time remaining, and a button that opens the video. The current lyric line
runs alongside it.

<p align="center">
  <img src="docs/img/overtone-in-discord.gif" alt="Overtone running on a Discord profile: a custom activity header, the song title, a lyric line moving with the music, and a progress bar" width="320">
</p>

<p align="center">
  <em>The header, the title, and a lyric line that moves with the song.<br>
  These lyrics came from a local transcription — no database had this track.</em>
</p>

---

## What it does

- **YouTube and YouTube Music** — video thumbnail or album art, title, channel or artist
- **A header you control** — `Listening to doli, szevczor, yokinashi - 162020`, not just `Listening to YouTube`
- **Real progress** — Discord's own bar with time remaining, following pauses and seeks
- **Lyrics from two sources** — [LRCLIB](https://lrclib.net) when it has the song, YouTube's own subtitle track when it does not, including auto-generated and auto-translated tracks
- **Live streams** — elapsed time instead of remaining
- **Privacy mode** — shows that you are watching something without saying what
- **Several tabs** — a playing video wins over a paused one
- Autostart, tray menu, log window

---

## How it works

Overtone is two pieces, and that is forced rather than chosen:

![Architecture](docs/img/architecture.svg)

Discord's RPC runs over a local named pipe (`\\.\pipe\discord-ipc-0`). A browser
extension cannot open one. A desktop app, in turn, cannot see inside a YouTube
tab. So the extension reads the player, the agent talks to Discord, and a
WebSocket on `127.0.0.1:8787` sits between them.

That socket is reachable from any page you visit, so the agent checks the
`Origin` header and accepts extension origins only; `http(s)://` gets a 403.

Playback data comes from YouTube's own player API through a content script in
the **MAIN world**, not from scraping the DOM — `getVideoData()` returns the
video id, title and author directly, and survives layout changes.

---

## Lyrics, and why timing is the hard part

Discord allows **5 presence updates per 20 seconds**. Lyric lines change every
two to five. That budget, not the network, is what makes this difficult.

![Why lyric timing needs a scheduler](docs/img/timing.svg)

Two things follow from it.

**Sends are aligned to line boundaries.** Sending as soon as the rate limiter
opens makes the visible lag depend on where the line change happens to fall
inside the window — so a fixed lead-in is too early in one case and too late in
the other. Because LRCLIB provides the whole timeline up front, the scheduler
knows when the next line starts and waits for it whenever waiting costs less
than sending text that is already stale.

**Short lines share an update.** At a two-second cadence half the lines would
never appear at all. When consecutive lines fit together inside Discord's
128-character limit, one update carries both. Nothing is ever shortened: a line
either fits whole or waits for the next update. Merging also stops at a blank
LRC cue, since that marks deliberate silence.

Subtitles get neither treatment, because the next line is unknown until YouTube
renders it. They are read straight from the player as it displays them, which
is why they need no synchronisation of their own.

### Your own lyrics

Everything Overtone finds is saved as a plain `.lrc` in
`%APPDATA%\Overtone\lyrics`, so playing a song again needs no network, and so
there is a file to fix when the timing is off. **A file you have edited is never
overwritten and outranks every other source** — being able to correct one is the
whole point.

For songs no database knows, `tools/transcribe-to-lrc.py` turns an audio file
you already have into a matching `.lrc` using Whisper:

```bash
python tools/transcribe-to-lrc.py song.mp3 --video-id o33IHl7-g9Y --language pl
```

It needs `stable-ts` and `faster-whisper`. Whisper guesses, so treat sung
lyrics as a first draft worth correcting.

Overtone can also do this by itself. Switch on **Fehlende Lyrics lokal erzeugen**
and a song nothing else covers gets downloaded, transcribed, filed and the audio
deleted again — helping the *next* play, never the one that triggered it. It is
off by default because it saturates every core for a good fraction of the song's
length, which is not something to start behind your back.

A job outlives the song that started it: change track and it keeps going, and
anything played meanwhile joins a queue rather than being dropped. The settings
window shows what is running — downloading or transcribing, for how long, what
is waiting, and how the last few finished. A job takes minutes and
shows nothing until it completes, so without that a working agent and a stuck
one look identical.

By default a song with subtitles is left alone, since those are free and
instant. Turn on **Auch dann, wenn YouTube-Untertitel vorhanden sind** when the
available track is auto-generated and garbles the words, or is a translation
rather than the sung text.

Two things decided quality here, both measured rather than assumed:

**Language detection is the weak link, not Whisper.** On a Polish track, letting
it guess produced fluent Russian nonsense in 125 s; pinning `pl` gave readable
Polish in 52 s — faster *and* correct. The bigger `medium` model detects
languages far better, which is why it is the default, but it is not immune: on
the same track it also chose Russian and fell into a repetition loop, emitting
one phrase eleven times for the whole song.

**So bad output is rejected rather than filed.** A wrong `.lrc` is worse than
none: it silently outranks every other source and looks deliberate. Overtone
refuses results that repeat one line throughout or come from a language guess it
is not confident about — while leaving genuine choruses alone.

---

## Install

### 1. Create a Discord application

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Copy the **Application ID**

### 2. Install the agent

Take the installer from the [latest release](../../releases/latest):

| File | What it does |
|---|---|
| `Overtone.Setup.x.y.z.exe` | Installs with start-menu and desktop shortcuts |
| `Overtone-x.y.z-portable.exe` | Runs without installing |

The settings window opens on first start. Paste the Application ID and you are
done; Overtone then lives in the tray.

> Windows SmartScreen warns on first run because the binary is not commercially
> signed. **More info → Run anyway.** A certificate costs money annually and
> changes nothing about the program.

From source instead: `npm install && npm start`.

### 3. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder

> After updating the extension files, click **↻** *and reload open YouTube
> tabs*. Unpacked extensions never reload themselves, and content scripts are
> not injected into tabs that are already open. The agent warns when the
> extension it is talking to is out of date.

### 4. Check one Discord setting

**User Settings → Activity Privacy → "Display current activity as a status
message"** has to be on.

---

## The activity header

![What each part of the card is](docs/img/presence.svg)

The header is a prefix plus a name:

| `activityType` | Prefix |
|---|---|
| `auto` | video → `Watching …`, music → `Listening to …` |
| `listening` | `Listening to …` |
| `watching` | `Watching …` |
| `playing` | `Playing …` |

Discord normally fills the name with your application's name, which is why it
would read the same for every song. RPC does accept an explicit name and the
desktop client renders it, so `activityName` is a template for it:

```
{artist} - {title}    ->    Listening to doli, szevczor, yokinashi - 162020
```

Placeholders: `{artist}`, `{title}`, `{channel}`. Multiple artists are
normalised to the comma form Spotify uses — `doli x szevczor x yokinashi`
becomes `doli, szevczor, yokinashi`. Leave the template empty to fall back to
the application name. It is skipped in privacy mode, so the header cannot give
away what the rest of the presence is hiding.

---

## What it cannot do

- **The cover art is not clickable.** Discord never turns the large image into a
  link; only buttons are links. Hence the button underneath.
- **It does not touch your custom status.** The status field on your profile can
  only be set with your user token — self-botting, against Discord's terms, and
  the token grants full access to the account. Overtone does not go near it. The
  closest legitimate equivalent is **"lyric on the first line"**, which puts the
  lyric in bold at the top and moves the title below it.
- **You may not see the buttons on your own profile.** Discord sometimes hides
  them in your own preview. Other people see them.
- **Lyrics can lag.** With LRCLIB the scheduler keeps the error under about
  0.6 s on average and never sends early. Subtitles have no lookahead, so up to
  roughly 4 s.
- **Subtitles must be switched on in the player.** Overtone reads what YouTube
  actually displays; with subtitles off there is nothing to read.
- **Transcription is not live.** Whisper needs a good fraction of the song's
  length on CPU, so lyrics it produces arrive for the next play. The presence
  says so while a job runs.
- **It does not break copy protection.** Audio comes from the one player client
  that still serves it plainly; clients that offer only DRM-protected streams
  are left alone.

---

## Configuration

Everything is reachable from the settings window or the tray menu. The file
lives at `%APPDATA%\Overtone\config.json`.

| Setting | Default | Meaning |
|---|---|---|
| `clientId` | – | Discord Application ID |
| `port` | `8787` | Bridge port; must match the extension |
| `activityType` | `auto` | Header prefix |
| `activityName` | `{artist} - {title}` | Header name; empty = application name |
| `showTimestamps` | `true` | Progress bar |
| `showButton` | `true` | Button to the video |
| `privacyMode` | `false` | Hide title and artwork |
| `lyricsEnabled` | `true` | Lyric line in the presence |
| `lyricsSource` | `auto` | `auto`, `lrclib`, `captions` |
| `lyricsMusicOnly` | `false` | Lyrics only on YouTube Music |
| `lyricsProminent` | `false` | Lyric on the first, bold line |
| `lyricsCombine` | `1` | Merge strength: `0` off, `1`, `1.5`, `2` |
| `lyricsSave` | `true` | Save found lyrics as .lrc files |
| `transcribeEnabled` | `false` | Transcribe songs nothing else covers |
| `transcribeLanguage` | – | Pin the language, e.g. `pl`; empty detects |
| `transcribeModel` | `medium` | tiny, base, small, medium |
| `transcribeEvenWithCaptions` | `false` | Transcribe even when subtitles exist |
| `ytdlpJsRuntime` | `node` | JS runtime yt-dlp needs; empty to leave it alone |
| `lyricsOffset` | `0` | Manual trim in seconds; only for skewed LRC files |
| `highResArtwork` | `true` | `maxresdefault` instead of `hqdefault` |

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

Architecture notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Bridge protocol: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## License

MIT — see [`LICENSE`](LICENSE).

Not affiliated with Discord, YouTube or Google.

*[Deutsche Fassung](README.de.md)*
