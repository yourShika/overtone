# Overtone

**Show what you're watching on YouTube — on your Discord profile.**

<p align="center">
  <img src="docs/img/overtone-in-discord.gif" alt="Overtone on a Discord profile: the artist and song in the header, the title, a lyric line moving with the music, and a progress bar" width="320">
</p>

<p align="center">
  <a href="../../releases/latest"><b>⬇ Download for Windows</b></a> &nbsp;·&nbsp;
  <a href="#setup">Setup</a> &nbsp;·&nbsp;
  <a href="#something-not-working">Help</a> &nbsp;·&nbsp;
  <a href="README.de.md">Deutsch</a>
</p>

---

## What it does

Your friends see the song, not just "watching YouTube".

- 🎵 **The song in the header** — `Listening to doli, szevczor - 162020`, instead of the same "YouTube" for everything
- 🖼️ **Cover art** — the video thumbnail, or the album art on YouTube Music
- ⏱️ **A real progress bar** — with time remaining, following pauses and skips
- 🎤 **The lyrics, line by line** — moving along with the song
- ▶️ **A little badge** — playing, paused, on repeat, or live
- 🔗 **A button to the video** — one click and they're watching it too
- 🔒 **Shy mode** — show that you're watching something, without saying what

---

## Setup

About five minutes, once.

### 1 · Install the app

Download from the [latest release](../../releases/latest) and run it.

Windows will warn you that it doesn't recognise the program — that's because the file isn't signed with a paid certificate, not because anything is wrong with it. Click **More info → Run anyway**.

Overtone then sits quietly in your system tray, next to the clock.

### 2 · Get your Discord ID

Discord needs to know who's asking before it will show anything.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and sign in
2. Click **New Application**, give it any name, agree, **Create**
3. Copy the **Application ID**
4. Paste it into Overtone's settings window (it opens on first start)

That's the only fiddly bit, and you never have to touch it again.

### 3 · Add it to your browser

1. Open `brave://extensions` or `chrome://extensions`
2. Switch on **Developer mode**, top right
3. Click **Load unpacked** and pick the `extension` folder
4. Reload any YouTube tabs you already had open

### 4 · One Discord setting

**Settings → Activity Privacy → "Display current activity as a status message"** has to be switched on. It usually already is.

Play something. Your profile should show it within a few seconds.

---

## About the lyrics

Overtone looks in three places, in this order:

**1. A lyrics database.** [LRCLIB](https://lrclib.net) is free and covers most well-known music, with the timing already right.

**2. YouTube's own subtitles.** Plenty of music videos have the lyrics as a subtitle track. This catches songs no database knows — but the subtitles have to be **switched on in the player**, otherwise there's nothing to read.

**3. Your PC works it out.** Optional, and off by default. Overtone can listen to the song and write the lyrics itself. This takes a few minutes and works your processor hard, so it never helps the song that's playing — but the lyrics are saved, and they're there the next time you play it.

Everything found is kept as a small text file on your PC. Play the song again and it's instant. If the timing is slightly off, you can open the file and fix it — and **Overtone will never overwrite something you've edited**.

---

## Good to know

- **The cover art isn't clickable.** Discord doesn't allow that for any app — only buttons can be links. That's why there's a button underneath.
- **Lyrics can lag a little.** Discord only allows an update every few seconds, so a fast rap track won't be perfectly in step. Overtone times its updates as well as that limit allows.
- **Your custom status stays yours.** Overtone doesn't touch the status text on your profile. Changing that automatically would mean handing over your account password, essentially — so it doesn't go near it.
- **Windows only, for now.**

---

## Something not working?

**Nothing shows up on Discord**
Is the desktop Discord app running? The browser version can't do this. Then check the Overtone settings window — it says whether Discord and your browser are connected.

**It says "YouTube" instead of the song**
Your browser is still running the old version of the add-on. Click ↻ next to Overtone in `brave://extensions`, then reload your YouTube tabs.

**No lyrics**
Some songs simply aren't in any database. Try switching subtitles on in the YouTube player — Overtone can read those.

**Friends can't see the button**
Discord sometimes hides buttons when you look at your *own* profile. Ask someone else what they see.

Still stuck? [Open an issue](../../issues) and say what you expected and what happened instead.

---

<sub>Free and open source ([MIT](LICENSE)). Not affiliated with Discord, YouTube or Google.<br>
Building or tinkering? See [`docs/`](docs/) for the settings reference and how it works inside.</sub>
