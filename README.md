# Score Stand

A personal sheet-music reader for iPad, iPhone and Mac. It's an installable web app (PWA) with no build step: plain HTML, CSS and ES modules.

## What it does (v1)

- **Library**: import PDFs (file picker, or drag and drop on the Mac), search by title or tag.
- **Reader**: two pages side by side in landscape, one in portrait. Turn pages with a Bluetooth pedal or the keyboard (→ ↓ PageDown Space = next, ← ↑ PageUp = back), or tap the left or right third of the screen. Tap the middle to hide the toolbar.
- **Half-page turns** (½): the top half shows the next page while you finish the bottom of the current one.
- **Markup** (✎): pen in three colours, highlighter, eraser, undo. "Pencil only" keeps fingers free for page turns.
- **Setlists**: play several scores back to back.
- **Practice spots** (◎): bookmark a page with a name, one goal and a target tempo, then jump back to it from the reader or the Spots tab.

Everything is stored on the device in IndexedDB for now. Syncing between devices (Supabase) is phase 2. See [SECURITY.md](SECURITY.md).

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
vendor/             pdf.js 6.4.299 (legacy build), perfect-freehand 1.2.3
```
