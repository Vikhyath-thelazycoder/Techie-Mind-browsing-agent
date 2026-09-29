# Batch C Report — Phase 7 (Human handover, voice, multilingual) + Phase 8 (Persistent monitoring)

**Status:** code complete, 2026-09-29. **Mode (user decision):** in the cloud I ran only the
TypeScript check, lint/format and the build. GitHub CI ran the unit and real-Chrome suites. The
manual checks in real Chrome are the user's: [BATCH_C_CHECKLIST.md](BATCH_C_CHECKLIST.md).

## What was built

**Phase 7: human handover that resumes (spec §24–26)**
- **Resumable handovers.** OTP, CAPTCHA/bot check, sign-in and a firewall confirmation now **pause**
  the task instead of ending it (RUNNING → HUMAN_REQUIRED → PAUSED → RESUME).
  - A handover card says **why** it stopped, **what you need to do**, and **until when** it waits
    (30 min).
  - Buttons: **I've done it — continue** (or **Approve once** for a confirmation), and **Stop**.
  - Resume re-checks the tab and runs the step that stopped again. Nothing is skipped.
- **Pause / Stop** while a task runs. Both take effect between steps, never halfway through an
  action. A paused task can be continued.
- **Approve once.** A confirmation approval lifts the confirmation for **that one control on that
  site**, and nothing else. Payment, OTP, CAPTCHA and all other firewall checks still apply.
- **Financial boundary.** Checkout, "Proceed to Buy", "Place order", "Buy now" and "Pay now" are
  never pressed. The agent stops and says the payment is yours. This fixes Mac Problem 4.
- **State survives a service-worker restart.** Checkpoints are stored with redacted texts; no page
  values are kept.

**Phase 7: voice and languages (spec §44–45)**
- **Mic, language and speaker buttons** in the side panel. Spoken requests run exactly like typed
  ones.
- **Local Whisper by default.** Audio goes only to a whisper.cpp server on the Mac.
- **Chrome Web Speech** (audio goes to Google) is used only after explicit consent in Settings.
- **"Allow microphone"** in Settings works around Chrome's side-panel permission limit.
- **Spoken replies** give a short status line in your language (EN/HI/KN/TA/TE) plus the key detail.
- **Multilingual commands.** Kannada, Hindi, Tamil and Telugu, in native script and romanized, plus
  code-switched mixes, resolve to the same intents as English.
  - Covered: search, play, open, price limits ("से कम", "ಒಳಗೆ", "se kam"), cheapest, back, scroll,
    add to cart, summarize.
  - Spot-checked on 20 sentences in all 4 languages. The language is detected from what you wrote.

**Phase 8: persistent monitoring (spec §38–43)**, in your own Supabase project (`apps/backend/`):
- **Database.** Postgres tables with row-level security: monitors, check history and the
  notification outbox.
- **Scheduler and worker.** pg_cron calls the worker every 5 min. Monitors are claimed with a lease
  and `SKIP LOCKED`.
- **Safe fetching.** The SSRF-safe fetch checks DNS on every hop: https on port 443 only, no private,
  metadata or localhost addresses, a size cap and a timeout.
- **Reading the page.** Price comes from schema.org data, meta tags or the text. The worker also
  reads stock status and a content fingerprint, and detects bot checks.
- **Alerts.** Sent only on a false → true transition, from an atomic check + outbox transaction.
  - A unique dedupe key, also used as Resend's idempotency key, prevents duplicate alerts.
  - Failed checks and failed sends retry with backoff.
- **Monitor API.** Authenticated by the user's token and scoped per user, so there is no IDOR. The
  e-mail address comes from the verified account.
- **Extension.**
  - Settings → Monitoring: project URL + anon key, sign up / sign in, and the monitor list with Check
    now / Pause / Resume / Cancel / Delete.
  - "monitor this…" now creates the monitor on the backend.
  - Stock alerts: "tell me when it's back in stock".
  - The sign-in session is stored encrypted, like the profile.

**Batch B Mac-check fixes**
1. YouTube channel/profile links rank below videos, and sponsored placements are penalized.
2. A bounded extra wait when a page is still empty after the first wait (Amazon's challenge page).
3. "Cheapest" and "compare":
   - only items matching the searched words, including exact numbers ("15" ≠ "17e");
   - sponsored cards dropped;
   - ₹0 treated as no price;
   - card noise ("Add to Compare") removed from titles.
4. "Proceed to Buy" is recognized as the payment step (see the financial boundary above).
5. Research falls back to DuckDuckGo when Google shows a human check. If both are blocked, it hands
   over as a CAPTCHA and can continue after you solve it.

## Checks run

- TypeScript: clean, extension and backend (the Edge Functions are type-checked too).
- ESLint + Prettier: clean.
- Build: Chrome + Firefox.
- Unit tests and real Chrome: run by GitHub CI on the PR (see the PR). Not run in the cloud session,
  by choice.

## Known gaps

- **Unit tests for the new code.** Resume, voice, multilingual rewriting and the backend's pure
  logic have no unit tests yet, by the batch's no-tests decision. They should be added in Batch D
  (Phase 10 hardening).
- **Stores that block cloud servers.** Monitoring such stores records "blocked" and retries; it never
  sends a false alert. Pages with schema.org product data work best.
- **Microphone permission.** It must be granted once in Settings; Chrome won't prompt inside the side
  panel.
- **Free Supabase projects pause after about a week idle.** Restore the project from the dashboard.
