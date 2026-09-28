# Batch B — working checklist (Phase 5 + Phase 6)

Re-read this file after any context compaction. Tick an item only when its test passes.

Environment notes:

- Cloud container: no Laya/Ollama, and live websites are blocked by the network policy. Workflows
  are proven on local fixture sites in real Chromium; the Phase 5 live milestone (YouTube, Flipkart,
  Amazon) runs on the Mac through the end-of-batch local prompt.
- Real-Chrome here: `TM_CHROMIUM=/opt/pw-browsers/chromium npm run test:browser` (1 known
  environment-only failure: `sidePanel.getPanelBehavior`).
- Baseline on main `0a915e6` (includes the Batch A Mac fixes): unit 393/393.
- Mac findings carried in: Qwen misses "the cheapest one" (needs prices) → deterministic price
  extraction; vision misses ~20 px icons (noted, not in scope).

## Phase 5 — Real agent workflows

- [x] Gates: `docs/phases/PHASE_5_GATES.md` + `scripts/verify/phase5.mjs`
- [x] In-page extraction: repeated items (title, price, currency, rating, link element) and main text
- [x] Constraints applied to results ("laptops under ₹50,000"); "the cheapest / costliest one"
- [x] Page commands become real: scroll up/down, go back/forward
- [x] Ecommerce: add to cart (verified), checkout navigation, stop before payment
- [x] Forms: encrypted local profile (Settings → Profile), field mapping, fill via vault tokens,
      verify, never unknown/secret fields, never submit without confirmation
- [x] Summarize page: local extraction → privacy redaction → local model (code summary without it)
- [x] Trusted click (chrome.debugger) for media, so YouTube plays past the autoplay block
- [x] Task output (items / text / table) in TaskResult, side panel and history (redacted)
- [x] Unit + real-Chrome fixture tests with the user's kind of sentences

## Phase 6 — 12 skills

- [x] Gates: `docs/phases/PHASE_6_GATES.md` + `scripts/verify/phase6.mjs`
- [x] Skill registry: 12 manifests (Skill contract), intent phrases, runner dispatch, UI progress
- [x] summarize-page, extract-data, compare-prices, find-alternatives, deep-research
- [x] fill-form, screenshot-walkthrough
- [x] manage-bookmarks, organize-tabs, read-later, save-page (browser APIs, confirmations)
- [x] monitor-page: monitor definition stored locally (backend scheduler is Batch C)
- [x] Skill matrix test: every skill has intent, execution, privacy, security, verification, tests

## Wrap-up

- [x] lint, typecheck, unit, browser, verify
- [x] `docs/phases/BATCH_B_REPORT.md`, status docs, merge to main, local-sync prompt
