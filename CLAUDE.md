# PepBros Peptide Tracker — Project Guide

A mobile-first PWA for tracking peptide supply, doses, cycles, and history, with
multi-user cloud sync. **Vanilla JS, no framework, no build step.**

- **Repo:** https://github.com/jmactheman/peptide-tracker (remote `origin`)
- **Live:** https://jmactheman.github.io/peptide-tracker/ (GitHub Pages, auto-deploys from `main` ~1–2 min after push)
- **Local:** `/Volumes/EXCHANGE/Peptidetracker/`

## Files
- `index.html` — all markup (tabs, modals, forms). No templating.
- `app.js` — the app: supply/dose/cycle/history/dashboard logic, rendering, IndexedDB reads/writes.
- `db.js` — IndexedDB wrapper (`PeptideTrackerDB`, version 3). Stamps `updatedAt`, queues sync, tombstones.
- `auth.js` — Supabase auth (Google + email magic link), account UI, sign-in sheet, welcome.
- `sync.js` — cloud sync (pull→merge→push, LWW, tombstones, account-switch guard, cloud delete).
- `data.js` — static peptide catalog / presets.
- `styles.css` — all styles (CSS custom props for theming; `data-theme` dark/light).
- `sw.js` — service worker (network-first, precaches assets).
- `manifest.json` — PWA manifest.
- `PeptideTracker.html` — legacy/standalone; **not** the shipped app. Ignore.

## Ship workflow (follow this every change)
1. Edit files.
2. `node --check <file>.js` for any JS touched.
3. **Verify before shipping** — this project leans hard on verification:
   - Pure logic → a Node simulation (load the real module in a `vm` context with
     mocked globals; see how `/tmp/*_sim.js` were used for sync/merge).
   - UI / browser behavior → the **Claude_Preview** MCP. `.claude/launch.json` has
     a `static` config (`python3 -m http.server 8137`). Start it, `preview_eval`
     to exercise functions, `preview_screenshot` for layout, `preview_console_logs`
     (level `error`) to confirm clean.
     - ⚠️ In headless preview, `alert()`/`confirm()` **block** `preview_eval` (it
       times out). Override `window.alert`/`window.confirm` before calling code
       that uses them.
4. **Bump versions** (cache-busting — required or users get stale code):
   - In `index.html`, bump every `?v=N` (all `<script>`/`<link>`). Currently **v32**.
   - In `sw.js`, bump `CACHE = 'pepbros-vN'`. Currently **pepbros-v47**.
   - If you add a new asset, also add it to the `ASSETS` array in `sw.js`.
5. Commit with a descriptive message + trailer, then push:
   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```
   (Commit/push only when the user asks, or as the agreed end of an increment.)

## Data model
- **Stores (IndexedDB + Supabase tables):** `peptides`, `doses`, `cycles`, `protocols`, `settings`.
- **Peptide:** `{ id, name, unit('mg'|'IU'|'mL'|'units'), displayUnit('mcg'|'mg'|'units'),
  trackingMode('simple'|'full'), mgPerVial, vialsOnHand, dailyDose, dosesPerWeek,
  cycleDuration, reorderThreshold, color, reconstituted{waterMl,remainingUnits,...},
  schedule{mode:'daily'|'specificDays'|'everyN'|'random', days:[0..6], everyN}, createdAt, updatedAt }`.
  - `trackingMode 'simple'` = Quick (no vial tracking); `'full'` = Track Vial.
  - `unit === 'units'` is a sentinel for Quick-mode syringe-unit peptides.
- **Dose:** `{ id, peptideId, peptideName, date('YYYY-MM-DD'), time('HH:MM'), amount,
  unit, site, notes, loggedAt, updatedAt }`.
- IDs are client-generated (`genId()`), globally stable — relied on by sync.
- Display helpers in `app.js`: `dispUnit(p)`, `dispAmt(mcgAmt,p)`, `isIU(p)`, `doseUnit(p)`.

## Cloud sync (Phase 1 — DONE)
- **Backend:** Supabase project `https://mxcpjsdvdqhgutdzzggo.supabase.co`.
  Publishable (anon) key is in `auth.js` — it's *meant* to be public; RLS protects data.
  The **secret** key must never be committed.
- **Tables:** each store → a table `(user_id uuid, id text, data jsonb, updated_at timestamptz,
  deleted boolean, PK(user_id,id))`, RLS policy `own_rows` = `user_id = auth.uid()`. (DDL was
  run by the owner in the Supabase SQL editor; not in the repo.)
- **Model:** IndexedDB is the offline working copy; Supabase is the canonical per-user copy.
  - `db.js` stamps `updatedAt` on every put, queues changes in `_pending`, and writes
    soft-delete **tombstones** to `_tombstones` (so deletes propagate). `{raw:true}` skips
    this (used when sync applies remote changes).
  - `sync.js`: `fullSync()` = pull → merge (last-write-wins by `updatedAt`, tombstones win) →
    refresh UI → push. Runs on sign-in, app foreground (throttled 30s), and network `online`.
    `pushChanges()` = debounced incremental push after edits.
  - **Account-switch guard:** `localStorage 'pb_owner_uid'` records which account owns this
    device's data; if a *different* account signs in, local data is wiped before pulling, so
    one user's data can't leak into another's account. Anonymous local data is adopted by the
    first account to sign in.
- **Auth:** Google + email magic link. Magic-link email currently uses Supabase's rate-limited
  test sender (Google is reliable; Resend SMTP is the planned fix — see below).
- **Gotchas:**
  - Test push/pull from the device that actually *has* data (an empty device pushing nothing
    is correct behavior, not a bug).
  - Magic-link/OAuth redirect URLs must be allowlisted in Supabase → Auth → URL Configuration.
  - A localhost preview can't complete Google OAuth (redirect is bound to the live URL).

## Roadmap / deferred
- **Phase 2 (sync):** incremental pull via `updated_at` cursors (currently full pull each sync),
  optional realtime, and **Resend SMTP** for reliable magic-link email (removes the test-sender
  rate limit). All optimizations — Phase 1 is fully functional without them.
- **Phase 3 (native):** SwiftUI iOS app reusing this same Supabase backend; add **Sign in with
  Apple** then (App Store requires it once Google login exists), and consider CloudKit/SwiftData.
  Apple Developer Program ($99/yr) is deferred until this phase.
- **Other deferred UI:** dashboard "Take" → upgrade site-picker to a chip grid; expose the unit
  calculator from the Log Dose tab too.

## Conventions / notes
- Theme via CSS custom properties on `:root[data-theme]`; accent red is `#dc2626` (header uses `#dc0517`).
- Tabs: `switchTab(id)`; lazy-renders per tab. Bottom nav + desktop top tabs both call it.
- Modals: `.modal-overlay` + `.modal`; open via `classList.add('active')`, close via `closeModal(id)`.
- Design handoffs (History, Cycles redesigns) came as bundles in `~/Downloads/design_handoff_*` —
  one-offs, already implemented; not needed going forward.
