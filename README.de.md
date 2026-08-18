# Overtone

**Discord Rich Presence für YouTube und YouTube Music — mit zeitsynchronen Lyrics.**

Zeigt an deinem Discord-Profil, was du gerade schaust oder hörst: Titel, Kanal
bzw. Artist, das Video-Thumbnail als Cover, einen Fortschrittsbalken mit
Restzeit und einen Button, der direkt zum Video führt. Optional läuft die
aktuelle Songzeile mit.

```
+------------------------------------------+
|  ######   Hört Daft Punk - Instant Cr… zu |
|  ######   Daft Punk - Instant Crush      |
|  ######   > I didn't want to be the one  |
|  ######   =========------  2:14 übrig    |
|           +----------------------------+ |
|           |   Auf YouTube ansehen      | |
|           +----------------------------+ |
+------------------------------------------+
```

---

## Wie es aufgebaut ist

Zwei Teile, weil es technisch nicht anders geht:

| Teil | Was es tut | Warum es sein muss |
|---|---|---|
| **Extension** (Chrome/Brave/Edge) | Liest Titel, Position, Dauer, Cover und Untertitel aus dem YouTube-Player | Nur im Browser kommt man an den Player |
| **Agent** (Tray-Anwendung) | Spricht mit Discord, holt Lyrics, baut die Presence | Discord RPC läuft über eine lokale Named Pipe — da kommt keine Extension ran |

Dazwischen liegt ein WebSocket auf `127.0.0.1:8787`, der ausschließlich
Extension-Origins akzeptiert.

```
YouTube-Tab --probe.js (MAIN world)--> bridge.js --> Service Worker
                                                          |  ws://127.0.0.1:8787
                                                          v
                        Discord <-- IPC -- Agent --> LRCLIB (Lyrics)
```

Details in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Installation

Ausführliche Schritt-für-Schritt-Anleitung: **[`docs/SETUP.md`](docs/SETUP.md)**.
Kurzfassung:

### 1. Discord-Application anlegen

1. [Discord Developer Portal](https://discord.com/developers/applications) -> **New Application**
2. Als Namen eintragen, was in Discord über der Aktivität stehen soll — z. B. `YouTube`
3. Die **Application ID** kopieren

### 2. Agent installieren

Aus `dist/` (nach `npm run build`, siehe [Build](#build)):

| Datei | Was sie tut |
|---|---|
| `Overtone Setup 1.4.0.exe` | Installiert mit Startmenü- und Desktop-Verknüpfung |
| `Overtone-1.4.0-portable.exe` | Läuft ohne Installation, direkt starten |

Beim ersten Start öffnen sich die Einstellungen. Application ID eintragen, fertig.
Danach läuft Overtone im Tray — kein Terminalfenster.

> Windows SmartScreen meldet sich beim ersten Start („Computer geschützt"), weil
> die EXE nicht kommerziell signiert ist. **Weitere Informationen -> Trotzdem
> ausführen.** Eine Signatur kostet jährlich Geld und ändert nichts am Programm.

Alternativ direkt aus dem Quellcode: `npm install && npm start`.

### 3. Extension laden

1. `brave://extensions` bzw. `chrome://extensions` öffnen
2. **Entwicklermodus** aktivieren
3. **Entpackte Erweiterung laden** -> Ordner `extension/` auswählen

> **Nach jedem Update der Extension-Dateien:** in `brave://extensions` auf **↻**
> klicken **und offene YouTube-Tabs neu laden**. Entpackte Erweiterungen laden
> sich nie von selbst neu, und Content-Scripts werden nicht in bereits offene
> Tabs nachgeladen. Der Agent warnt inzwischen, wenn die verbundene Extension
> veraltet ist.

### 4. Discord-Einstellung prüfen

**Benutzereinstellungen -> Aktivitätsdatenschutz -> „Aktivitätsstatus anzeigen"**
muss an sein.

---

## Was es kann

- **YouTube & YouTube Music** — Video-Thumbnail bzw. Album-Cover, Titel, Kanal/Artist
- **Fortschritt** — echter Discord-Balken mit Restzeit, folgt Pause und Seek
- **Button zum Video** — optional zusätzlich einer zum Kanal
- **Live-Streams** — laufende Zeit statt Restzeit
- **Lyrics aus zwei Quellen** — zeitsynchron aus [LRCLIB](https://lrclib.net)
  (kostenlos, ohne API-Key) **oder direkt aus den YouTube-Untertiteln**,
  inklusive automatisch erzeugter und automatisch übersetzter Spuren
- **Privat-Modus** — zeigt „Schaut ein Video", ohne zu verraten was
- **Mehrere Tabs** — laufendes Video gewinnt gegen pausiertes
- **Autostart**, Tray-Menü, Log-Fenster

## Die Überschrift der Aktivität

Die Kopfzeile besteht aus zwei Teilen:

```
<Präfix aus dem Aktivitätstyp>  +  <Name>
```

Das Präfix bestimmt `activityType`:

| Aktivitätstyp | Präfix |
|---|---|
| `auto` | Video -> `Schaut …`, Musik -> `Hört … zu` |
| `listening` | `Hört … zu` |
| `watching` | `Schaut …` |
| `playing` | `Spielt …` |

Den Namen dahinter füllt Discord normalerweise mit dem Namen deiner Application
aus dem Developer Portal — deshalb stünde dort bei jedem Song dasselbe.
**RPC nimmt aber ein eigenes `name`-Feld entgegen, und der Client zeigt es an**
(gegen Discord Stable verifiziert). `activityName` ist eine Vorlage dafür:

```
{artist} - {title}     ->   Hört doli, szevczor, yokinashi - 162020 zu
```

Platzhalter: `{artist}`, `{title}`, `{channel}`. Mehrere Künstler werden zur
Komma-Form normalisiert, wie Spotify es schreibt — aus `doli x szevczor x
yokinashi` wird `doli, szevczor, yokinashi`. Leer lassen für den
Application-Namen. Im Privat-Modus greift die Vorlage nicht, damit die
Kopfzeile nicht verrät, was der Rest der Presence gerade verbirgt.

## Was es nicht kann

- **Das Cover ist nicht klickbar.** Discord macht das große Bild grundsätzlich
  nicht zu einem Link — nur Buttons sind klickbar. Deshalb der Button darunter.
- **Der Custom-Status wird nicht verändert.** Das Statusfeld am Profil lässt
  sich nur mit deinem User-Token setzen — Selfbotting, gegen die Discord-ToS,
  und der Token gewährt vollen Zugriff auf den Account. Overtone fasst ihn nicht
  an. Als Ersatz gibt es **„Songzeile in die erste Zeile"** in den
  Einstellungen: die Lyrics stehen dann fett ganz oben, der Titel rutscht
  darunter.
- **Buttons sieht man bei sich selbst nicht immer.** Discord blendet sie in der
  eigenen Profilvorschau gelegentlich aus. Andere sehen sie.
- **Lyrics können nachhinken.** Discord erlaubt nur 5 Updates pro 20 Sekunden.
  Bei LRCLIB legt Overtone die Updates gezielt auf die Zeilenwechsel und bleibt
  damit im Mittel unter 0,6 s — und nie zu früh. Bei Untertiteln geht das nicht,
  weil kommende Zeilen unbekannt sind; dort bis zu ~4 s.
- **Untertitel müssen im Player eingeschaltet sein.** Overtone liest, was
  YouTube tatsächlich anzeigt. Sind die Untertitel aus, gibt es nichts zu lesen.

---

## Konfiguration

Alles über das Tray-Menü oder **Einstellungen**. Die Datei liegt unter:

```
%APPDATA%\Overtone\config.json
```

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `clientId` | – | Discord Application ID |
| `port` | `8787` | Bridge-Port (muss zur Extension passen) |
| `activityType` | `auto` | Video -> „Schaut", Musik -> „Hört" |
| `activityName` | `{artist} - {title}` | Überschrift der Aktivität; leer = Application-Name |
| `showTimestamps` | `true` | Fortschrittsbalken |
| `showButton` | `true` | Button zum Video |
| `privacyMode` | `false` | Titel und Cover verbergen |
| `lyricsEnabled` | `true` | Songzeile als Status |
| `lyricsSource` | `auto` | `auto` (LRCLIB, sonst Untertitel), `captions`, `lrclib` |
| `lyricsMusicOnly` | `false` | Lyrics nur auf YouTube Music |
| `lyricsProminent` | `false` | Songzeile in die erste, fette Zeile |
| `lyricsCombine` | `1` | Kurze Zeilen zusammenfassen: `0` aus, `1` Standard, `1.5`, `2` |
| `lyricsOffset` | `0` | Feinabstimmung in Sekunden; nur bei schiefen LRC-Dateien nötig |
| `highResArtwork` | `true` | `maxresdefault` statt `hqdefault` |

## Build

```bash
npm run build
```

Erzeugt unter `dist/`:

- `Overtone Setup 1.4.0.exe` — NSIS-Installer
- `Overtone-1.4.0-portable.exe` — ohne Installation lauffähig

> Die Build-Konfiguration liegt in
> [`agent/electron-builder.config.js`](agent/electron-builder.config.js), nicht
> in `package.json`. Grund: npm-Workspaces heben `electron` ins
> Root-`node_modules`, wo electron-builder die Version nicht findet — die
> JS-Konfiguration liest sie direkt aus dem installierten Paket.

## Tests

```bash
npm test
```

57 Unit-Tests (Lyrics-Timing, Quellenauswahl, Titel-Bereinigung,
Activity-Payload, Rate-Limiter, Interpolation, Logger). Dazu
`npm run test:integration` — 6 Tests gegen das echte LRCLIB und die
Origin-Sperre des Bridge-Servers.

## Projektstruktur

```
Overtone/
  extension/          Chrome/Brave MV3-Extension
    manifest.json
    src/
      background.js       Service Worker, WebSocket, Tab-Auswahl
      content/probe.js    MAIN world: Player-API + Untertitel
      content/bridge.js   ISOLATED world: filtert und leitet weiter
      popup/
  agent/              Electron-Tray-Anwendung
    src/
      main.js             Orchestrierung, Tray, Tick-Loop
      bridge.js           WebSocket-Server mit Origin-Pruefung
      session.js          Playback-Zustand + Positions-Interpolation
      discord/ipc.js      Named-Pipe-Protokoll, ohne Dependencies
      discord/presence.js Rate-Limiting (5 Updates / 20 s)
      discord/activity.js Baut das Activity-Payload
      lyrics/             LRCLIB-Client, LRC-Parser, Titel-Bereiniger
    test/                 Unit- und Integrationstests
    ui/                   Einstellungsfenster
  tools/make-icons.mjs    PNG-Generator (nur node:zlib)
  docs/
```

## Lizenz

MIT

---

*[English version](README.md)*
