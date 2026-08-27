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

## overlay — a page for OBS

Shows the cover, the title, the artist, elapsed and remaining time, and the
lyric line moving with the song.

**Setting it up:** switch it on in *Plugins*, copy the address it shows, and add
a **Browser Source** in OBS with that address. 900 × 200 suits the card and the
bar; 900 × 320 the lyrics.

### Several sources at once

Every setting is a value in the address, so one feed can drive as many sources
as you like. Paste the same address into a second Browser Source and change one
value in it:

```
…/overlay/?style=card&lyricStyle=spotify        the song, on one scene
…/overlay/?style=lyrics&lyricStyle=slideUp      the lyrics alone, on another
…/overlay/?style=bar&showLyrics=false           a thin strip along an edge
```

What the panel sets is the default; the address is what a given source actually
uses.

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

Your page receives the song over `EventSource('feed')` — a relative URL, so the
address's token travels with it. What arrives is the song, the artist, the
artwork, the times and the lyric cues, and nothing else: no account name, no
file paths, no settings but your own.

Your code runs in the browser that opened the page, never inside Overtone. That
is why a plugin cannot read your files or reach Discord, and why installing one
is not a decision that needs a warning.
