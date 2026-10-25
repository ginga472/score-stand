# Security notes

Score Stand is a single-user app. The goal is a small attack surface and nothing worth stealing.

## v1 (local only)

- **No backend.** GitHub Pages serves static files only. Scores, markup, setlists and spots live in IndexedDB on each device and never leave it.
- **Content Security Policy** (in `index.html`): `default-src 'none'`. Scripts, styles, workers, fonts and images load only from this origin. No inline scripts or styles. `'wasm-unsafe-eval'` is allowed only so pdf.js can run its bundled image decoders (JBIG2/JPEG 2000), which are common in scanned music.
- **No third-party code at runtime.** No CDNs, analytics, ads or web fonts. Libraries are vendored and pinned in `vendor/`.
- **pdf.js locked down.** We use only the core rendering API: no viewer, no annotation layer, no form/JS scripting (the QuickJS sandbox isn't shipped), no XFA. pdf.js 6.x removed the `isEvalSupported` font path behind CVE-2024-4367.
- **No HTML injection.** UI text (titles, tags, spot notes) is set with `textContent`, never `innerHTML`.
- **Import limits.** PDFs only, 80 MB max.

## Phase 2 (sync) checklist

Before syncing goes live with Supabase:

- [ ] Public sign-up disabled; one account, created in the dashboard. Sign in with a magic link or passkey.
- [ ] Row Level Security enabled on every table, with policies restricted to `auth.uid() = owner`.
- [ ] Storage bucket is private; PDFs are read through short-lived signed URLs.
- [ ] Only the publishable (anon) key in the client. The service-role key never goes in the repo or the app.
- [ ] CSP `connect-src` widened to the single Supabase project URL only.
- [ ] Automated test: an unauthenticated client tries to read every table and the bucket, and gets nothing back.
- [ ] Dependabot or manual check on vendored library versions.
