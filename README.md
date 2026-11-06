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

`ios/Woodshed.xcodeproj` (the Woodshed app) wraps the reader and Chord Sprint into one iPad app that also hears the piano over USB and can record practice sessions. Open it in Xcode, pick your Team under Signing & Capabilities, plug in the iPad and Run. With a free Apple ID, run it again every 7 days.

- **Metronome**: the ♩ button in the top bar (and in the reader). The click is scheduled on the same clock as the piano's MIDI, and while recording, every start, stop and tempo change goes into the session file (`metronome` markers with `bpm` and a `downbeatMs`), so a review can tell where the playing stayed with the click. `scripts/woodshed_sessions.py clicks FILE` summarizes it.
- **Plan for today**: a review's notes can carry a `plan` of up to 4 short blocks (label, score, page, bars, minutes, optional bpm, goal). The Music screen shows it; Start opens the score, sets the click, records, and runs a soft timer that chimes when time's up. Blocks can be done in any order, stretched, skipped, or folded away. A block's optional `boxes` (from `scripts/score_bars.py box PDF 15-18`, which finds the barlines in the PDF) spotlight its bars while it runs (nothing is drawn on them; the rest of the page fades). Tap the bars to adjust: drag to move, corner to resize.

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
theme.css           shared colors and type (Music, Sessions, Chord Sprint)
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
js/practice.js      metronome panel + plan-timer bridge (plain script, shared with Chord Sprint)
js/plan.js          "Plan for today" card on the Music screen
chord-sprint/       chord sight-reading game
supabase/           sync schema, session sync + reviewer account (sessions.sql, setup-sessions.sh)
scripts/            woodshed_sessions.py: Claude's client for reviewing sessions; score_bars.py: bar finder for plan boxes
ios/                iPad app (Swift: web view shell, USB MIDI, session recorder)
vendor/             pdf.js 6.4.299 (legacy build), perfect-freehand 1.2.3
```
