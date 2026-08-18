# Architektur

## Warum zwei Teile?

Die naheliegende Frage zuerst: warum nicht einfach eine Extension?

Discord Rich Presence läuft über **lokales IPC** — unter Windows eine Named Pipe
(`\\.\pipe\discord-ipc-0`), unter macOS und Linux ein Unix-Socket. Eine
Browser-Extension hat auf beides keinen Zugriff; die Chrome-Sandbox erlaubt
weder Named Pipes noch Unix-Sockets, und es gibt keine Extension-API dafür.

Der umgekehrte Weg geht genauso wenig: eine reine Desktop-Anwendung kommt nicht
an den Zustand eines YouTube-Tabs. Man könnte den Fenstertitel auslesen, aber
daraus bekommt man weder Position noch Dauer noch Video-ID — also weder
Fortschrittsbalken noch Cover noch Lyrics-Synchronisation.

Also beides, mit einem lokalen WebSocket dazwischen. Genau diese Aufteilung
verwenden auch PreMiD und vergleichbare Projekte.

```
┌─ Browser ──────────────────────────────┐   ┌─ Agent (Electron) ──────────┐
│                                        │   │                             │
│  YouTube-Tab                           │   │  Bridge (ws-Server)         │
│    ├─ probe.js    (MAIN world)         │   │    ↓                        │
│    │    liest movie_player.getVideo…   │   │  Session                    │
│    ↓  postMessage                      │   │    ↓ interpoliert Position  │
│    └─ bridge.js   (ISOLATED world)     │   │  buildActivity              │
│         filtert, sendet bei Änderung   │   │    ↓                        │
│         ↓ chrome.runtime.sendMessage   │   │  PresenceController         │
│  Service Worker                        │   │    ↓ 5 Updates / 20 s       │
│    wählt aktiven Tab                   │   │  DiscordIPC                 │
│    ↓                                   │   │    ↓ Named Pipe             │
└────┼───────────────────────────────────┘   └────┼────────────────────────┘
     │        ws://127.0.0.1:8787                 │
     └────────────────────────────────────────────┘        Discord
```

---

## Extension

### `content/probe.js` — MAIN world

Läuft **im Seitenkontext**, nicht in der Extension-Sandbox (`"world": "MAIN"` im
Manifest). Das ist der entscheidende Kniff: dadurch ist YouTubes eigene
Player-API erreichbar.

```js
const player = document.getElementById('movie_player');
player.getVideoData();   // { video_id, title, author, isLive }
player.getCurrentTime();
player.getPlayerState(); // 1 = playing, 2 = paused, 3 = buffering
```

Warum nicht einfach DOM scrapen? Weil YouTube sein Markup regelmäßig umbaut und
jeder CSS-Selektor irgendwann bricht. Die Player-API ist seit Jahren stabil,
liefert die kanonische Video-ID auch bei Shorts und Playlists und weiß, ob ein
Stream live ist. DOM-Scraping bleibt als Fallback für die ersten Sekunden nach
dem Laden, bevor der Player existiert.

Sendet jede Sekunde einen Snapshot per `window.postMessage`.

### `content/bridge.js` — ISOLATED world

Der Empfänger. Leitet bewusst **nicht** jeden Tick weiter:

| Auslöser | Warum sofort |
|---|---|
| Video gewechselt | Nicht vorhersagbar |
| Pause / Play | Nicht vorhersagbar |
| Sprung > 2 s gegenüber der Erwartung | Der Nutzer hat gespult |
| Sonst alle 5 s | Heartbeat |

Zwischen den Meldungen rechnet der Agent die Position selbst hoch. Der Heartbeat
hat einen zweiten Zweck: **jede `chrome.runtime`-Nachricht setzt den 30-Sekunden-
Leerlauf-Timer des MV3 Service Workers zurück.** Ein laufendes Video hält den
Worker damit von selbst am Leben.

### `background.js` — Service Worker

Zwei Aufgaben.

**Tab-Auswahl.** Mehrere YouTube-Tabs können gleichzeitig melden, aber genau
einer darf die Presence bestimmen. Regel: laufend schlägt pausiert, bei
Gleichstand die jüngste Meldung. Ohne diese Regel würde ein vergessener
pausierter Tab im Hintergrund das Video überschreiben, das man gerade schaut.

**Verbindung.** Hält den WebSocket zum Agent, mit exponentiellem Backoff von
2 s bis 30 s. Ein `chrome.alarms`-Weckruf pro Minute baut die Verbindung nach
einer trotzdem erfolgten Worker-Eviction wieder auf.

---

## Agent

### `bridge.js` — WebSocket-Server

**Der sicherheitskritische Teil.** Ein Server auf `127.0.0.1` ist von *jeder*
besuchten Webseite erreichbar — localhost ist im Browser keine Vertrauensgrenze.
Ohne Prüfung könnte jede beliebige Seite gefälschte Presence an dein Profil
schicken.

Browser setzen bei WebSocket-Handshakes den `Origin`-Header, und Seiten-
JavaScript kann ihn nicht fälschen. Also:

```js
const ALLOWED_ORIGIN = /^(chrome-extension|moz-extension|extension|safari-web-extension):\/\//i;
```

- Extension-Origin → akzeptiert
- `http(s)://…` → **403**
- Gar kein Origin (nativer Client) → akzeptiert; wer lokal Code ausführt, hat
  ohnehin mehr Möglichkeiten, als dieser Server bietet

Ein Ping/Pong-Heartbeat alle 30 s räumt halboffene Verbindungen weg — sonst
bliebe nach einem Browser-Absturz eine Presence für immer stehen.

### `session.js` — Positions-Interpolation

Meldungen kommen alle 5 Sekunden, Lyrics brauchen Genauigkeit im
Sub-Sekunden-Bereich. Die Session merkt sich die letzte gemeldete Position **und
den Zeitpunkt der Meldung** und rechnet hoch:

```
position = gemeldet + (jetzt − empfangen) / 1000 × playbackRate
```

Jede neue Meldung setzt den Anker neu, damit sich kein Fehler aufsummiert.

### `discord/ipc.js` — Protokoll

Rahmenformat:

```
[ opcode : uint32 LE ][ länge : uint32 LE ][ payload : UTF-8 JSON ]
```

| Opcode | Bedeutung |
|---|---|
| 0 | HANDSHAKE — `{ v: 1, client_id }` |
| 1 | FRAME — Befehle und Antworten |
| 2 | CLOSE |
| 3 / 4 | PING / PONG |

Nach dem Handshake antwortet Discord mit `DISPATCH`/`READY`. Danach:

```json
{ "cmd": "SET_ACTIVITY", "nonce": "…", "args": { "pid": 1234, "activity": { … } } }
```

Die Pipes werden von `discord-ipc-0` bis `-9` durchprobiert, weil parallel
laufende Clients (Stable / PTB / Canary) den Zähler hochzählen. Unter Linux
kommen Flatpak- und Snap-Unterverzeichnisse dazu.

Eigene Implementierung statt npm-Paket, weil `discord-rpc` seit Jahren nicht
gepflegt wird und die Alternativen native Module mitbringen, die bei jedem
Electron-Update neu gebaut werden müssten. Das Protokoll sind ~200 Zeilen.

### `discord/presence.js` — Rate-Limiting

**Die bestimmende Randbedingung des ganzen Projekts.** Discord erlaubt
`SET_ACTIVITY` fünfmal pro 20 Sekunden. Wer mehr sendet, dessen Frames werden
verworfen — und bei anhaltendem Überschreiten die Verbindung geschlossen.

Songzeilen wechseln alle 3–5 Sekunden. Das liegt exakt an der Grenze.

Der Controller trennt deshalb *gewünscht* von *gesendet*:

- Die Tick-Schleife setzt beliebig oft den Wunschzustand
- Gesendet wird zum frühestmöglichen erlaubten Zeitpunkt, immer der neueste Stand
- Zwischenstände fallen weg, statt sich aufzustauen

Dazu ein Vergleich, der **Zeitstempel-Rauschen ignoriert**: `timestamps.start`
wird bei jedem Tick aus `jetzt − position` neu berechnet und schwankt dabei um
Millisekunden. Ohne Toleranz (±2 s) sähe jeder Tick wie eine Änderung aus und
das gesamte Budget ginge für Nichts drauf.

#### Wann gesendet wird — die eigentliche Genauigkeit

Die naheliegende Regel „sende, sobald der Limiter es erlaubt" macht die
sichtbare Verzögerung davon abhängig, **wo im Fenster der Zeilenwechsel zufällig
liegt**: Eine Zeile, die direkt nach einer Sendung wechselt, wartet die vollen
4 Sekunden; eine, die kurz vor dem nächsten Slot wechselt, geht fast sofort
raus. Diese Streuung ist der Grund, warum ein fester Vorlauf das Problem nicht
lösen kann — er passt an genau einer Stelle im Fenster und ist überall sonst zu
früh oder zu spät.

Bei LRCLIB kennen wir aber **alle künftigen Zeilenanfänge**. Damit lassen sich
die beiden Optionen direkt vergleichen:

| Option | Kosten |
|---|---|
| Am freien Slot senden | Die gesendete Zeile ist schon veraltet und bleibt ab der Grenze falsch, bis der übernächste Slot kommt: `(frei + Schritt) − Grenze` |
| Auf die Grenze warten | Die vorige Zeile steht etwas länger, dafür landet die neue exakt richtig: `Grenze − frei` |

Warten gewinnt genau dann, wenn `Grenze − frei < Schritt / 2`. Diese eine
Bedingung beseitigt beide Fehlerarten. Gemessen an einem simulierten Song
(16 Zeilen, 2,7–4,4 s):

```
                              Zeile stimmt   Ø-Fehler   Bereich
vorher (fester Vorlauf 1,5 s)     62-67 %      0,83 s   -1,29 s .. +2,77 s
nachher (an Zeilengrenzen)          73 %       0,60 s    0,00 s .. +1,24 s
```

Der Inhalt wird zusätzlich **erst beim Senden** abgerufen (`provider`), nicht
beim Erkennen der Änderung — zwischen beidem liegen bis zu 4 Sekunden, in denen
der Song weiterläuft.

#### Zeilen zusammenfassen

Ein Update alle 4 Sekunden reicht nicht, wenn die Zeile alle 2 wechselt — dann
fällt jede zweite komplett aus. `lyricWindow()` fasst deshalb Zeilen zusammen,
die eine Sendung ohnehin mit abdecken muss, sofern sie **ganz** ins
Zeichenlimit passen. Gekürzt wird nie; eine Zeile passt vollständig oder wartet
aufs nächste Update. An einer leeren LRC-Marke (bewusste Stille) endet das
Zusammenfassen, damit nicht über einen Instrumentalteil hinweg geklebt wird.

Gemessen an 24 Zeilen im 2-Sekunden-Takt, deterministisch reproduzierbar:

```
Reichweite      gezeigt   längster State   Zeilen erscheinen bis zu
aus               12/24        21 Zeichen  -
1x (Standard)     18/24        77 Zeichen  4 s früher
1,5x              20/24        97 Zeichen  6 s früher
2x                22/24       120 Zeichen  8 s früher
```

`1x` ist der prinzipielle Standard: Zusammengefasst wird genau das, was die
*nächste* Sendung ohnehin nicht mehr retten könnte — Vollständigkeit ohne
Preisgabe der Taktung. Höhere Stufen holen mehr Zeilen, zeigen sie aber früher.

Wichtig für den Scheduler: `nextTime` ist die Grenze der ersten **nicht**
mitgesendeten Zeile. Andernfalls würde er eine Sendung für Text einplanen, der
längst am Profil steht.

Für Untertitel greift nichts davon: kommende Zeilen sind unbekannt, es gibt
nichts zu planen. Dort bleibt es beim „sobald erlaubt".

### `lyrics/` — Textzeilen

1. **`trackparse.js`** macht aus `ARTIST - Song (Official Video) [4K] | Label`
   ein sauberes Paar. Werbeklammern raus (`official`, `4k`, `lyrics`),
   bedeutungstragende bleiben (`remix`, `live`, `acoustic`). Ein Kanal namens
   `Artist - Topic` ist eine verlässliche Artist-Angabe; YouTube Music liefert
   echte Metadaten und überspringt fast die ganze Heuristik.

2. **`lrclib.js`** fragt [LRCLIB](https://lrclib.net) ab — kostenlos, ohne
   API-Key. Erst `/api/get` (exakt, mit Dauer als Filter), sonst `/api/search`
   mit eigener Bewertung nach Dauer-Nähe und Titel-Ähnlichkeit. Zwei Cache-
   Ebenen (Speicher + Platte), Fehltreffer werden 6 Stunden gemerkt, damit ein
   Song ohne Text nicht alle vier Sekunden neu angefragt wird.

3. **`lrc.js`** parst das LRC-Format und beantwortet „welche Zeile gilt bei
   Sekunde X?" per Binärsuche. Eine Besonderheit: hält eine Zeile länger als
   12 Sekunden, wird `null` zurückgegeben. Sonst bliebe während eines
   Instrumental-Teils eine tote Zeile am Profil stehen, was kaputt aussieht.

### Untertitel als zweite Quelle

LRCLIBs Abdeckung endet schnell, sobald man den internationalen Mainstream
verlässt. YouTube-Untertitel schließen genau diese Lücke: bei Musikvideos ist
die Spur sehr oft der Songtext selbst, bereits perfekt synchronisiert, und
automatisch erzeugte wie übersetzte Spuren gibt es zusätzlich.

Gelesen wird aus dem **gerenderten DOM**, nicht als Trackdatei:

```js
document.querySelector('.ytp-caption-window-container')
        .querySelectorAll('.caption-visual-line')   // Fallback: .ytp-caption-segment
```

Der naheliegende Weg wäre der `timedtext`-Endpunkt, der die komplette Spur mit
Zeitstempeln liefert — und damit auch Vorlauf ermöglichen würde. Er verlangt
inzwischen aber signierte Parameter, die sich ohne Ankündigung ändern. Was auf
dem Bildschirm steht, ist dagegen exakt das Gewünschte und per Definition
synchron.

Preis dafür: **kein Vorlauf möglich.** Kommende Zeilen sind unbekannt, also
lässt sich Discords 4-Sekunden-Fenster hier nicht ausgleichen. Deshalb gewinnt
LRCLIB im Modus `auto`, wenn es den Song kennt.

Zweite Einschränkung: Overtone sieht nur Untertitel, die **eingeschaltet** sind.
Sind sie aus, rendert YouTube nichts. Ein Erzwingen wäre über
`player.loadModule('captions')` möglich, würde dem Nutzer aber ungefragt
Untertitel ins Bild setzen — bewusst nicht gemacht.

Eine Lücke in der Untertitelspur führt **nicht** zum Rückfall auf die andere
Quelle: liefert LRCLIB Zeilen und liegt die Position in einer Pause, bleibt es
leer. Sonst stünde während eines Instrumental-Teils fremder Text am Profil.

### `thumbnails.js`

YouTube erzeugt `maxresdefault.jpg` nur, wenn der Uploader eine hochauflösende
Quelle geliefert hat — sonst 404, und Discord zeigt ein graues Feld. Also erst
per HEAD prüfen, Ergebnis pro Video merken. `hqdefault.jpg` existiert immer und
ist das Sicherheitsnetz.

YouTube Music liefert Cover von Google-Servern mit Größen-Suffix
(`=w60-h60`), das sich einfach auf `=w544-h544` umschreiben lässt.

---

## Bewusste Einschränkungen

**Kein klickbares Cover.** Discord macht das große Bild grundsätzlich nicht zu
einem Link. Nur `buttons` sind klickbar — daher der Button darunter.

**Kein automatischer Custom-Status.** Das Statusfeld am Profil lässt sich nur
über den User-Token setzen. Das ist Selfbotting, verstößt gegen die Discord-ToS
und riskiert eine Accountsperre. Die Lyrics laufen deshalb im `state`-Feld der
Rich Presence — optisch praktisch dasselbe, nur eben erlaubt.

**Kein „Listen Along" wie bei Spotify.** Das ist eine First-Party-Integration
mit Discord-Vertrag, keine offene API. Nachbauen lässt sich das Aussehen
(Aktivitätstyp „Hört", Cover, Fortschritt, Artist-Zeile), nicht die Funktion.

---

## Erweiterbar

Für eine weitere Seite braucht es genau zwei Dinge:

1. Ein Probe-Script, das Snapshots im bekannten Format postet
   (siehe [`PROTOCOL.md`](PROTOCOL.md))
2. Einen `matches`-Eintrag im Manifest

Der Agent interessiert sich nicht für die Herkunft — `source` steuert nur die
Beschriftung und die Wahl zwischen „Schaut" und „Hört". Twitch, SoundCloud oder
Netflix wären jeweils ein Probe-Script.
