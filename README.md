# Kontoauszug Converter

Statische GitHub-Pages-App zum Umwandeln von Kontoauszug-PDFs in eine gemeinsame CSV- oder XLSX-Datei.

## Datenschutz

Die PDFs werden ausschliesslich lokal im Browser gelesen. Es gibt keinen Server, keinen Upload-Endpunkt und keine Speicherung im Repository. PDF.js wird lokal in `vendor/` mitgeliefert; CSV und XLSX werden direkt im Browser erzeugt.

## Ausgabe

Die exportierte Datei enthaelt diese Spalten:

- `Datum`
- `Erläuterung`
- `Betrag EUR`
- `Kontostand`

Bei mehreren PDFs werden alle Buchungszeilen zusammengefuehrt. Der am Ende einer PDF erkannte Kontostand wird in der vierten Spalte fuer die Zeilen dieser PDF eingetragen.

## Entwicklung

```bash
npm install
cp node_modules/pdfjs-dist/build/pdf.min.mjs vendor/pdf.min.mjs
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/pdf.worker.min.mjs
npm test
```

Danach kann `index.html` ueber einen lokalen Webserver oder GitHub Pages geoeffnet werden.
