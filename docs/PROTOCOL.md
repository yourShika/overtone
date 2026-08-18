# Bridge-Protokoll

JSON über WebSocket, `ws://127.0.0.1:8787`. Jede Nachricht:

```json
{ "type": "…", "payload": { }, "v": 1 }
```

Nur Extension-Origins werden angenommen — siehe
[`ARCHITECTURE.md`](ARCHITECTURE.md#bridgejs--websocket-server).

---

## Extension → Agent

### `hello`

Einmal direkt nach dem Verbinden.

```json
{ "type": "hello", "payload": { "client": "extension", "version": "1.0.0" } }
```

Der Agent antwortet mit einem `status`-Frame.

### `state`

Der Kern. Gesendet bei Videowechsel, Pause/Play, erkanntem Spulen, **neuer
Untertitelzeile** und sonst alle 5 Sekunden.

```json
{
  "type": "state",
  "payload": {
    "source": "youtube",
    "videoId": "a5uQMwRMHcs",
    "title": "Daft Punk - Instant Crush (Official Video)",
    "artist": "",
    "album": "",
    "channel": "Daft Punk",
    "channelUrl": "https://www.youtube.com/@daftpunk",
    "url": "https://www.youtube.com/watch?v=a5uQMwRMHcs",
    "thumbnail": "",
    "duration": 337.4,
    "position": 194.2,
    "playbackRate": 1,
    "paused": false,
    "live": false
  }
}
```

| Feld | Typ | Bedeutung |
|---|---|---|
| `source` | `"youtube"` \| `"ytmusic"` | Steuert Beschriftung und Aktivitätstyp |
| `videoId` | string | YouTube-ID; identifiziert den Track |
| `title` | string | Roher Titel — der Agent bereinigt ihn selbst |
| `artist` | string | Nur bei `ytmusic` gefüllt |
| `album` | string | Nur bei `ytmusic`, für die Lyrics-Suche |
| `channel` | string | Kanalname; Fallback-Artist |
| `channelUrl` | string | Für den optionalen zweiten Button |
| `url` | string | Ziel des Buttons |
| `thumbnail` | string | Nur bei `ytmusic`; sonst leitet der Agent es aus `videoId` ab |
| `duration` | number | Sekunden; `0` bei Live |
| `position` | number | Sekunden |
| `playbackRate` | number | Für korrekte Interpolation bei ≠ 1× |
| `paused` | boolean | |
| `live` | boolean | Unterdrückt die Restzeit |
| `caption` | string | Aktuell eingeblendete Untertitelzeile; `""` wenn aus |
| `captionTrack` | string | Sprache der aktiven Spur, z. B. `pl` oder `en (auto)` |

Alle Felder werden im Agent (`session.js`) typgeprüft und normalisiert. Fehlende
Felder sind zulässig.

### `clear`

Nichts läuft mehr — Tab geschlossen, Video zu Ende, kein aktiver Tab.

```json
{ "type": "clear", "payload": { "reason": "pagehide" } }
```

### `command`

Steuert den Agent aus dem Popup.

```json
{ "type": "command", "payload": { "name": "openSettings", "args": {} } }
```

| Name | Wirkung |
|---|---|
| `openSettings` | Öffnet das Einstellungsfenster |
| `toggleEnabled` | Schaltet die Presence um |

---

## Agent → Extension

### `status`

Nach `hello` und danach bei jeder Zustandsänderung. Speist das Popup.

```json
{
  "type": "status",
  "payload": {
    "version": "1.0.0",
    "enabled": true,
    "discordConnected": true,
    "discordUser": "someuser",
    "browserClients": 1,
    "port": 8787,
    "lastError": null,
    "lyrics": {
      "status": "found",
      "line": "I didn't want to be the one",
      "lineCount": 48,
      "origin": "lrclib",
      "captionsAvailable": true,
      "captionTrack": "en"
    },
    "now": { "title": "…", "artist": "…", "paused": false, "position": 194, "duration": 337 }
  }
}
```

`lyrics.status` ist eines von `idle`, `loading`, `found`, `captions`, `none`,
`disabled`. `lyrics.origin` sagt, woher die *angezeigte* Zeile stammt —
`lrclib` oder `captions`.

---

## Eine weitere Seite anbinden

Der Agent kennt keine Seiten, nur das Snapshot-Format. Für z. B. SoundCloud:

1. Probe-Script schreiben, das `{ __overtone__: true, snapshot }` per
   `window.postMessage` schickt — Vorlage: `extension/src/content/probe.js`
2. Im Manifest zu `matches` hinzufügen, für beide Content-Script-Einträge
   (MAIN und ISOLATED)

`bridge.js`, der Service Worker und der gesamte Agent bleiben unverändert.
`source` auf `"ytmusic"` setzen, wenn es Musik ist — dann wählt der
Automatik-Modus „Hört" statt „Schaut" und die Lyrics-Suche greift.
