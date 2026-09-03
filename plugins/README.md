# Plugins

A plugin is a folder. Copy one into your plugins folder, press **Read the folder
again** in Overtone under *Plugins*, and it turns up with whatever it asked to
have set.

**Where the folder is:** *Plugins → Open folder*. On Windows that is
`%APPDATA%\Overtone\plugins`.

Overtone ships the overlay below as an example, not as an installation. It sits
beside the program until you add it, and after that it is yours — edit it,
delete it, replace it. An Overtone update will not put your version back.

---

## Updating a plugin without updating Overtone

This is the point of a plugin being a folder.

1. Download the new folder (or pull this repository).
2. Replace the old one in your plugins folder.
3. In Overtone: *Plugins → Read the folder again*.

No installer, no restart. A new setting in the manifest appears in the panel by
itself, because the panel is built from the manifest rather than written
alongside it.

The one thing that would need a new Overtone is a plugin asking for a **control
type that does not exist yet** — the list is closed on purpose, so a plugin can
never hand this window markup it did not build. Everything else, including new
layouts, new animations and new settings, is the plugin's own business.

---

## overlay — two pages for OBS

One plugin, two addresses. Switch it on in *Plugins* and each page appears with
its own address and its own settings under it. Copy either, and add a **Browser
Source** in OBS with it.

### Now playing

The cover, the title, the artist, elapsed and remaining time, and the lyric line
moving with the song. 900 × 200 suits the card and the bar; 900 × 320 the
lyrics.

### Video

The video itself, muted, edge to edge — the thing to put at the *bottom* of a
scene at a low opacity, so a waiting screen or a pause card has something moving
behind it. Size it to the whole canvas, e.g. 1920 × 1080, and set the opacity in
OBS on the source itself.

Blur, zoom, brightness, contrast, colour, black-and-white, a tint and a vignette
are all on the page, so what OBS gets is already the picture you want.

Three things about it are worth knowing before you build a scene on it:

- **It plays muted, always.** The sound is already coming from wherever you are
  actually playing the song, and two of them a second apart is unusable.
- **Some videos refuse to be embedded.** Their uploader disallowed it, and
  YouTube shows a notice instead of playing. Nothing on this side can detect
  that — the player is a frame from another site — so *Show → The artwork* is a
  switch you flip rather than something that happens by itself. The artwork
  drifts slowly and always works.
- **It is YouTube's own embedded player**, so it can show ads, and it decodes
  the video a second time on your machine.
- **The player draws its own title and subtitles**, and neither can be switched
  off from outside it. The picture is grown until they fall off the edges —
  *Crop the player away* is that, and it is why a little of the frame is lost.

### Staying on the beat

The page asks the player where it is, several times a second, and pulls it back
when it has drifted. It also learns two things about your machine and remembers
them: how long a player takes to load, and how far a seek overshoots. So the
first video after installing settles within a couple of seconds, and every one
after that starts already in place.

What it cannot measure is the stretch between the YouTube tab and here — the
reading, the hops, the player's own start-up. That is **Timing**, and it is a
slider because you can see the answer in a second by watching both at once.
Minus shows the video later.

### Several sources at once

The address is bare and stays the same — paste it once, and it keeps working
after Overtone restarts. What the panel sets travels with the song, so moving a
slider there reaches a source that is already open.

A source that should differ from the rest names its own values on the end. Those
win over whatever the panel says:

```
…/overlay/?style=card&lyricStyle=spotify        the song, on one scene
…/overlay/?style=lyrics&lyricStyle=slideUp      the lyrics alone, on another
…/overlay/?style=bar&showLyrics=false           a thin strip along an edge
…/overlay/video.html?videoBlur=20               the video, blurred, behind both
```

So one Browser Source follows the panel, and another stays exactly as you left
it — from the same address, the same feed, and no second set of settings
anywhere in Overtone.

### What you can change

| | |
|---|---|
| `style` | `card` · `bar` · `lyrics` · `ticker` |
| `background` | `none` · `glow` · `soft` · `solid` |
| `accent` | `#rrggbb` — the progress bar, and the glow |
| `font` | `sans` · `round` · `serif` · `mono` · `condensed` |
| `scale` | 60–200 per cent |
| `smooth` | `true` · `false` — every fade and slide, or none |
| `lyricStyle` | `spotify` · `fade` · `slideUp` · `slideLeft` · `slideRight` · `plain` |
| `lyricLines` | `1` · `3` · `5` |
| `align` | `left` · `center` · `right` |
| `anchor` | `top` · `middle` · `bottom` |
| `showCover`, `showTimes`, `showLyrics` | `true` · `false` |
| `hideIdle`, `idleText` | what happens when nothing is playing |

And on the video page:

| | |
|---|---|
| `videoSource` | `video` · `art` — the video, or the artwork drifting |
| `videoFit` | `cover` · `contain` |
| `videoBlur` | 0–40 pixels |
| `videoZoom` | 0–60 per cent |
| `videoBrightness`, `videoContrast` | 10–200 per cent |
| `videoSaturate` | 0–300 per cent |
| `videoGrey` | 0–100 per cent |
| `videoTint`, `videoTintStrength` | `#rrggbb`, and 0–100 per cent of it |
| `videoVignette` | 0–100 per cent — darkens the edges |
| `videoDrift` | `true` · `false` — the slow pan on the artwork |
| `videoFade` | 0–3000 ms |
| `videoCrop` | 0–60 per cent — how much of the player's own title and subtitles is cut off |
| `videoSync` | −3…+3 s — trim, minus shows the video later |

Anything unrecognised in the address is ignored rather than obeyed.

---

## Writing your own

Copy `overlay/` and start from it. The whole contract is:

```
your-plugin/
  plugin.json     what it is, and what it wants set
  public/
    index.html    served to whatever browser opens the address
    …             css, js, svg, png, woff2
```

`plugin.json` needs `engine`, an `id` matching the folder name, a `name`, and
`"surface": true`. `settings` is a list of fields, each with a `type`
(`switch`, `number`, `range`, `choice`, `text`, `colour`, `note`), a `key`, a
`default`, and labels written as `{ "en": "…", "de": "…" }`. Overtone renders
them; you write no interface.

### More than one page

A plugin that offers several overlays says so, and each gets its own address in
the panel:

```json
"views": [
  { "id": "main",  "file": "index.html", "name": { "en": "Now playing" } },
  { "id": "video", "file": "video.html", "name": { "en": "Video" },
    "help": { "en": "Put this at the bottom of the scene." } }
]
```

A setting then names the page it belongs to with `"view": "video"`, and appears
under that page's address rather than in one undifferentiated list — otherwise
"Blur" says nothing about which of three overlays it changes. A setting that
names no page stays at the top, where it applies to all of them.

Write no `views` and nothing changes: the plugin has one page, `index.html`,
under its own name, which is what every plugin written before this meant.

Each page gets the same feed. `EventSource('feed')` is relative, so it resolves
the same from `…/your-plugin/` and from `…/your-plugin/second.html`.

Your page receives the song over `EventSource('feed')` — a relative URL, so the
address's token travels with it. What arrives is the song, the artist, the
artwork, the times and the lyric cues, and nothing else: no account name, no
file paths, no settings but your own.

Your code runs in the browser that opened the page, never inside Overtone. That
is why a plugin cannot read your files or reach Discord, and why installing one
is not a decision that needs a warning.
