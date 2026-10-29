# Security notes

Score Stand is a single-user app. The goal is a small attack surface and nothing worth stealing.

## v1 (local only)

- **No backend.** GitHub Pages serves static files only. Scores, markup, setlists and spots live in IndexedDB on each device and never leave it.
- **Content Security Policy** (in `index.html`): `default-src 'none'`. Scripts, styles, workers, fonts and images load only from this origin. No inline scripts or styles. `'wasm-unsafe-eval'` is allowed only so pdf.js can run its bundled image decoders (JBIG2/JPEG 2000), which are common in scanned music.
- **No third-party code at runtime.** No CDNs, analytics, ads or web fonts. Libraries are vendored and pinned in `vendor/`.
- **pdf.js locked down.** We use only the core rendering API: no viewer, no annotation layer, no form/JS scripting (the QuickJS sandbox isn't shipped), no XFA. pdf.js 6.x removed the `isEvalSupported` font path behind CVE-2024-4367.
- **No HTML injection.** UI text (titles, tags, spot notes) is set with `textContent`, never `innerHTML`.
- **Import limits.** PDFs only, 80 MB max.

## Sync (Supabase)

- `js/sync.js` talks to Supabase's REST endpoints with plain `fetch` (no SDK).
- Sign-in is email + password for the single account created in the dashboard (sign-ups are off). Use a long random password from a password manager.
- The session (access + refresh token) is kept in IndexedDB on the device. The CSP blocks injected scripts, which is what would otherwise be able to read it.
- PDFs are uploaded to and downloaded from a private bucket with the signed-in user's token; nothing is ever publicly readable.
- The publishable key in `js/config.js` is public by design. RLS is what protects the data.

## Sync checklist

Before syncing goes live:

- [ ] Public sign-up disabled; one account, created in the dashboard with a long random password (Supabase still accepts password sign-in even though the app uses codes).
- [ ] Row Level Security enabled on every table, with policies restricted to `auth.uid() = owner`.
- [ ] Storage bucket is private, with an owner-only policy on the user's folder.
- [ ] Only the publishable (anon) key in the client. The service-role key never goes in the repo or the app.
- [ ] CSP `connect-src` widened to the single Supabase project URL only.
- [ ] `supabase/check-security.sh` passes (anonymous reads, writes, bucket listing and sign-up all refused).
- [ ] Dependabot or manual check on vendored library versions.

## iPad app (`ios/`)

The iPad app bundles these same files and adds two things a web page can't do: reading the piano over USB MIDI, and recording practice sessions.

- **Nothing loads remotely.** A build step copies the web files into the app, and a custom `app://local/` scheme serves them from the bundle only (paths outside the bundled `web` folder get a 404). The page CSPs apply unchanged; the only network traffic is still Supabase sync.
- **Navigation is locked to the bundled pages.** Any other URL is refused; tapped `https` links open in Safari instead of inside the app.
- **Small native bridge.** Pages can only send three messages: `nav` (switch screen; an optional route must be a plain `#/path`), `session` (start/stop/list/share/delete recordings, add a marker) and `store` (Chord Sprint settings as a JSON string). Session files are looked up by name inside the app's `Sessions` folder only.
- **Recordings stay on the iPad** (Documents/Sessions, visible in the Files app) until shared by hand. They hold note numbers, timing, velocity, pedal and screen markers (score title and page), nothing else.
- Chord Sprint (`chord-sprint/`) has its own strict CSP (no inline script or style). It builds its staff SVG with `innerHTML` from internal data only; no user-entered text reaches it.
