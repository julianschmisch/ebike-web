# eBike App für Bluefy (Web Bluetooth), abgespeckt

Kleine Webseite für den Browser **Bluefy** auf dem iPhone. Kein Signieren, keine 7-Tage-Erneuerung.

Sie kann nur zwei Dinge: die **Fahrstufe wählen** (N, Eco, Normal, Sport) und den **Akkustand anzeigen**
(Balken grün über 50 %, orange bis 21 %, rot bei 20 % und darunter).
Kilometerzähler, Fahrzeit, Reichweite, Parkplatz und Akkuwarnung gibt es hier nicht, weil die Seite im Hintergrund
nicht laufen kann (iOS hält sie an, sobald der Bildschirm ausgeht oder Bluefy nicht vorne ist).

- Öffnen: die Adresse der Seite in Bluefy aufrufen, dann "Rad suchen".
- Es wird nichts gespeichert außer der gewählten Sprache. Gesendet wird nur die Fahrstufe, die man antippt.

## Dateien
- `index.html`, `style.css`, `app.js` – Oberfläche und Bluetooth
- `core.js`, `des.js` – Protokoll und Verschlüsselung (aus der Dart-App übernommen)
- `test/core.test.mjs` – Tests gegen dieselben Testwerte wie die Android-App (`node --test test/core.test.mjs`)
- `test/e2e.mjs` – Browser-Test mit nachgebautem Rad (braucht Playwright)
