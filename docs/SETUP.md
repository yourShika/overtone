# Einrichtung

Rechne mit rund zehn Minuten. Vier Schritte, in dieser Reihenfolge.

---

## 1. Discord-Application anlegen

Discord zeigt Rich Presence nur für eine registrierte Application an. Das ist
kostenlos und dauert eine Minute.

1. [discord.com/developers/applications](https://discord.com/developers/applications) öffnen
2. Oben rechts **New Application**
3. **Namen eingeben** — wichtig:

   > Der Name der Application ist die Überschrift der Aktivität.
   > Heißt sie `YouTube`, steht in Discord **„Schaut YouTube"**.
   > Heißt sie `Overtone`, steht dort **„Schaut Overtone"**.

   Für den gewohnten Look also `YouTube` nehmen.

4. **Create**, dann auf der Seite **General Information** die **Application ID**
   kopieren (eine lange Zahl)

### Optional: eigene Symbole

Unter **Rich Presence → Art Assets** lassen sich Bilder hochladen. Brauchst du
nicht — Overtone verwendet das YouTube-Thumbnail direkt. Nützlich ist nur ein
kleines Eck-Symbol:

| Asset-Name | Wofür | Eintragen unter |
|---|---|---|
| `youtube` | Kleines Logo unten rechts am Cover | Einstellungen → `sourceAssetKey` |
| `paused` | Symbol bei pausiertem Video | `pausedAssetKey` |
| `overtone` | Ersatzbild, wenn kein Thumbnail da ist | `fallbackAssetKey` |

Nach dem Hochladen kann es bis zu einer Stunde dauern, bis Discord neue Assets
ausliefert.

---

## 2. Agent installieren und starten

Voraussetzung: **Node.js 20 oder neuer** (`node -v` prüfen).

```bash
cd Overtone
npm install
npm start
```

Beim ersten Start öffnet sich das Einstellungsfenster automatisch, weil noch
keine Client-ID hinterlegt ist.

1. **Discord Client-ID** einfügen (die Zahl aus Schritt 1)
2. Fenster schließen — der Agent läuft weiter im Tray, unten rechts neben der Uhr

Läuft alles, zeigt der Punkt oben rechts im Fenster **Discord: verbunden**.

> Discord muss dabei laufen. Der Web-Client zählt nicht — Rich Presence
> funktioniert nur mit der Desktop-App, weil die lokale Verbindung sonst
> gar nicht existiert.

---

## 3. Extension laden

Funktioniert in Brave, Chrome, Edge, Opera und Vivaldi — alles Chromium.

1. `brave://extensions` bzw. `chrome://extensions` öffnen
2. Oben rechts **Entwicklermodus** einschalten
3. **Entpackte Erweiterung laden**
4. Den Ordner `Overtone/extension` auswählen

Das Overtone-Symbol erscheint in der Symbolleiste. Anheften lohnt sich — das
Popup zeigt den Status.

> **Warum Entwicklermodus?** Weil die Extension nicht im Chrome Web Store liegt.
> Für den Store bräuchte es ein Entwicklerkonto (einmalig 5 $) und eine
> Prüfung. Lokal geladen funktioniert sie identisch. Brave und Chrome fragen
> nach jedem Neustart, ob Entwickler-Extensions aktiv bleiben sollen —
> einmal bestätigen genügt.

---

## 4. Discord-Datenschutz prüfen

**Discord → Benutzereinstellungen → Aktivitätsdatenschutz**

- **„Aktivitätsstatus anzeigen"** muss **an** sein.

Ohne diesen Schalter kommt die Presence korrekt an, wird aber niemandem gezeigt.

---

## Funktioniert es?

YouTube-Video starten und im Extension-Popup nachsehen:

| Anzeige | Bedeutung |
|---|---|
| Grüner Punkt + „Verbunden als @name" | Alles läuft |
| „Agent nicht erreichbar (Port 8787)" | Agent läuft nicht — `npm start` |
| „Agent läuft — wartet auf Discord" | Discord-Desktop-App starten |
| „Kein YouTube-Tab aktiv" | Tab neu laden (nach Extension-Installation nötig) |

Am Discord-Profil sollte jetzt Titel, Cover, Fortschritt und der Button stehen.

---

## Autostart

Damit Overtone beim Hochfahren mitläuft: Rechtsklick auf das Tray-Symbol →
**Beim Anmelden starten**. Die App startet dann minimiert im Tray.

---

## Häufige Probleme

### „Port 8787 ist bereits belegt"

Entweder läuft Overtone schon (Tray prüfen), oder ein anderes Programm hat den
Port. In den Einstellungen einen anderen Port eintragen — **und denselben im
Extension-Popup unter „Erweitert"**. Beide müssen übereinstimmen.

### Presence erscheint gar nicht

Der Reihe nach:

1. Läuft die **Discord-Desktop-App**? Der Browser-Client reicht nicht.
2. Ist **„Aktivitätsstatus anzeigen"** an?
3. Zeigt das Extension-Popup einen grünen Punkt?
4. Ist die **Client-ID** korrekt (nur Ziffern)?
5. Tray → **Log-Ordner öffnen** und die letzten Zeilen lesen.

### Das Cover bleibt grau

Discord lädt externe Bilder über einen eigenen Proxy und cached sie. Bei einem
ganz frisch hochgeladenen Video kann das ein paar Minuten dauern. Bleibt es
grau, in den Einstellungen **„Hochauflösendes Thumbnail"** ausschalten — dann
wird `hqdefault` verwendet, das es für jedes Video garantiert gibt.

### Buttons sehe ich selbst nicht

Discord blendet Aktivitäts-Buttons in der eigenen Profilvorschau je nach Version
aus. Frag jemanden, der dein Profil anschaut — dort sind sie da.

### Lyrics werden nicht gefunden

Es gibt zwei Quellen, und die Einstellung **Lyrics → Quelle** entscheidet:

**1. LRCLIB (Datenbank).** Overtone fragt mit Artist und Titel ab, die aus dem
Videotitel extrahiert werden. Das misslingt bei Titeln ohne erkennbares Muster
(`bester song ever!!! 🔥`), und die Abdeckung ist außerhalb des internationalen
Mainstreams dünn — bei polnischem, tschechischem oder Underground-Rap findet
sich oft nichts.

Auf YouTube Music klappt es deutlich zuverlässiger, weil dort echte Metadaten
mitgeliefert werden statt eines geratenen Videotitels. Im Log steht, wonach
gesucht wurde:

```
[DEBUG] Lyrics-Suche: "Daft Punk" – "Instant Crush"
```

**2. YouTube-Untertitel.** Deckt alles ab, was die Datenbank nicht hat — bei
Musikvideos ist die Untertitelspur sehr oft der Songtext selbst, und zwar
bereits perfekt synchronisiert. Automatisch erzeugte und automatisch übersetzte
Spuren funktionieren genauso.

> **Voraussetzung: Untertitel müssen im YouTube-Player eingeschaltet sein.**
> Overtone liest, was YouTube tatsächlich einblendet. Sind sie aus, rendert
> YouTube nichts und es gibt nichts zu lesen.
>
> Einschalten über das **CC-Symbol** in der Player-Leiste oder mit der Taste
> **`c`**. Dauerhaft: **Zahnrad → Untertitel → Sprache wählen**. Die Auswahl
> merkt sich YouTube kontobezogen.

Im Standardmodus `auto` nimmt Overtone LRCLIB, wenn es den Song kennt, und
sonst die Untertitel. Bei überwiegend nischiger Musik lohnt **Nur
YouTube-Untertitel** — das spart auch jede Netzwerkabfrage.

Welche Quelle gerade läuft, steht im Einstellungsfenster unter „Aktuell":

```
Aus YouTube-Untertiteln · Spur pl
Aus LRCLIB · 48 Zeilen synchronisiert
```

### Lyrics stimmen zeitlich nicht

Discord erlaubt nur **5 Presence-Updates pro 20 Sekunden**, also etwa eines alle
4 Sekunden. Mehr geht nicht — schnellere Updates verwirft Discord, und wer
weiter drückt, fliegt raus.

Entscheidend ist deshalb, *wann* dieses knappe Budget ausgegeben wird. Bei
**LRCLIB** kennt Overtone alle künftigen Zeilenanfänge und legt die Updates
gezielt auf die Zeilenwechsel, statt sie zu senden, sobald der Limiter zufällig
aufmacht. Gemessen bleibt der Fehler damit im Mittel unter 0,6 s und die Zeile
kommt nie zu früh.

Bei **Untertiteln** geht das nicht: die nächste Zeile ist unbekannt, bis YouTube
sie einblendet. Dort können bis zu 4 Sekunden Verzug auftreten. Wenn dir Timing
wichtiger ist als Abdeckung, stelle die Quelle auf **Nur LRCLIB**.

Der Regler **Feinabstimmung** gehört normalerweise auf `0`. Er verschiebt alle
Zeilen um einen festen Betrag und ist nur dann sinnvoll, wenn eine bestimmte
LRC-Datei selbst verschoben ist — gegen die systematische Verzögerung hilft er
nicht, weil die je nach Position im Zeitfenster unterschiedlich groß ausfällt.

> Ältere Versionen hatten hier standardmäßig 1,5 s Vorlauf. Das war der falsche
> Ansatz und führte dazu, dass Zeilen mal zu früh, mal zu spät kamen. Wenn du
> aus einer alten Installation kommst, stelle den Regler auf 0.

### Agent aktualisiert, aber neue Funktionen fehlen

**Das häufigste Problem nach einem Update.** Agent und Extension werden getrennt
aktualisiert. Wer nur den Installer ausführt, hat weiterhin die alte Extension —
und damit fehlen alle Funktionen, deren Code im Browser sitzt, allen voran die
Untertitel.

Entpackte Erweiterungen laden sich **nie** von selbst neu. Nach jeder Änderung
an den Dateien unter `extension/`:

1. `brave://extensions` bzw. `chrome://extensions` öffnen
2. Bei Overtone auf **↻** klicken
3. **Offene YouTube-Tabs neu laden** — Content-Scripts werden nicht in bereits
   offene Tabs nachgeladen

Ob es geklappt hat, steht im Log:

```
[INFO] Extension verbunden: extension v1.1.0 [captions]
```

Fehlt `[captions]`, läuft noch die alte Version. Der Agent warnt dann auch
sichtbar im Einstellungsfenster.

### Nach einem Extension-Update passiert nichts mehr

Chrome lädt Content-Scripts nicht in bereits offene Tabs nach. Offene
YouTube-Tabs einmal neu laden.
