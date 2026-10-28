# Score Stand

A personal sheet-music reader for iPad, iPhone and Mac. It's an installable web app (PWA) with no build step: plain HTML, CSS and ES modules.

## What it does (v1)

- **Library**: import PDFs (file picker, or drag and drop on the Mac), search by title or tag.
- **Reader**: two pages side by side in landscape, one in portrait. Turn pages with a Bluetooth pedal or the keyboard (→ ↓ PageDown Space = next, ← ↑ PageUp = back), or tap the left or right third of the screen. Tap the middle to hide the toolbar.
- **Half-page turns** (½): the top half shows the next page while you finish the bottom of the current one.
- **Markup** (✎): pen in three colours, highlighter, eraser, undo. "Pencil only" keeps fingers free for page turns.
- **Setlists**: play several scores back to back.
- **Practice spots** (◎): bookmark a page with a name, one goal and a target tempo, then jump back to it from the reader or the Spots tab.

Everything is stored on the device in IndexedDB. When you sign in (top of the library), it syncs with your Supabase project: scores, markup, setlists and spots, last edit wins. Setup is in `supabase/schema.sql`; security notes in [SECURITY.md](SECURITY.md).

## Chord Sprint

`chord-sprint/` is a sight-reading game: a line of triads on the grand staff, play each one on a MIDI piano (Web MIDI in desktop Chrome, or USB in the iPad app). Tracks speed per chord and brings slow ones back more often.

## iPad app

`ios/PianoPractice.xcodeproj` wraps the reader and Chord Sprint into one iPad app that also hears the piano over USB and can record practice sessions. Open it in Xcode, pick your Team under Signing & Capabilities, plug in the iPad and Run. With a free Apple ID, run it again every 7 days.

## Running locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Hosting

GitHub Pages from the `main` branch root. On iPad or iPhone, open the site in Safari, then Share → Add to Home Screen.

## Layout

```
index.html          shell + Content Security Policy
app.css
sw.js               offline cache (network first)
js/app.js           hash router
js/library.js       scores, setlists, spots
js/reader.js        page display, turns, half turns, spots panel
js/ink.js           Pencil markup (perfect-freehand)
js/pdf.js           pdf.js wrapper
js/db.js            IndexedDB
js/ui.js            DOM helpers (textContent only, no innerHTML)
js/native.js        bridge to the iPad app (no-op in a browser)
chord-sprint/       chord sight-reading game
ios/                iPad app (Swift: web view shell, USB MIDI, session recorder)
vendor/             pdf.js 6.4.299 (legacy build), perfect-freehand 1.2.3
```
