# Techie Mind

The master spec for this project is [docs/TECHIE_MIND_SPEC.md](docs/TECHIE_MIND_SPEC.md) and the phased execution contract is [docs/master implementation plan.md](docs/master%20implementation%20plan.md). Read them before making architecture or implementation decisions — they are the source of truth.

## How work is done here

- **Batches, not single phases (user decision 2026-09-28, replaces "one phase at a time").** Phases 3–10 run as 4 batches:
  - **Batch A** = Phase 3 + 4 — starts by fixing the user-reported real-Chrome bugs (follow-up commands going to Google instead of the open tab, new-tab links opening duplicate products, "open Flipkart iPhone" dropping the query, "a" left in "play a Kannada song", agent not reusing its own tab). Each bug gets a real-Chrome test with the user's exact sentence first.
  - **Batch B** = Phase 5 + 6 (includes real-click playback past Chrome's autoplay block).
  - **Batch C** = Phase 7 + 8.
  - **Batch D** = Phase 9 + 10.
- **Don't stop between phases inside a batch.** Continue straight into the next phase. STOP only at the end of a batch and wait for the user to say go for the next batch.
- **Lightweight verification (user decision 2026-09-29, replaces the fast-checks-per-phase / live-milestone rule below).** The cloud session writes code and does a plain TypeScript check only — it does not run tests. The user tests live/browser behavior manually themselves. The local Mac session's job is just: pull the branch, skim the diff, run `npm run build` + `npm test` (vitest unit tests, no browser), and merge to `main` if green, with a short chat-level note (what changed, build/test status, anything odd) — not a full `docs/phases/BATCH_X_MAC_CHECK.md` report. `npm run test:browser`, `npm run test:live`, and model benches (Laya selftest, `npm run bench:models -- --vision`) are no longer run by default — only on explicit request for something specific.
- ~~Fast checks per phase: unit tests + local Chrome fixture tests, live-website tests and full regression only at milestones~~ (superseded above, 2026-09-29).
- ~~End of every batch: Mac session runs real-Chrome tests, model benches, live-site milestone tests, writes `docs/phases/BATCH_X_MAC_CHECK.md`~~ (superseded above, 2026-09-29).
- **Short reports.** One 1-page report per batch (`docs/phases/BATCH_X_REPORT.md`): what was built, test results, problems. The full 20-section format is used only for the final Phase 10 report.
- **Time budget.** Aim for about 1.5–2 hours per batch. Give short progress updates as each part finishes.
- **Vikhyath AI Engineering OS** (installed plugin) routes the work first: classify the task, activate only relevant capabilities (ECC always; Unlazy for multi-part phases; OpenDesign for UI). Unlazy/OpenDesign references live in `~/Developer/eos-capabilities/`.
- **Gates before code (Unlazy).** Write `docs/phases/PHASE_N_GATES.md` with runnable `CHECK:`/`EXPECT:` gates backed by `scripts/verify/phaseN.mjs` before implementing; a phase is complete only when every gate passes.
- `npm run verify` runs the current acceptance gates; `npm run build` must precede `npm run test:browser` / `npm run test:live` (live = real websites, needs internet).
- Evidence (screenshots, latency/live JSON) goes to `evidence/` — Playwright wipes `test-results/` every run.
- No site-specific selectors or scripts in runtime code: `sites.ts` is routing data only; the Phase 1 verifier scans for hard-coded acceptance phrases.
- Current status: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Design decisions: [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md).

Key rules to keep in mind at all times:

- Models propose actions; only the local action firewall authorizes execution.
- Code first, models only when needed: Code → Laya → Qwen 7B → API. Vision is lazy/on-demand, after DOM/A11y.
- Explicit sites ("open YouTube") navigate directly — never turn them into a Google search.
- Privacy is local: detect/redact before anything leaves the browser. No raw PII in logs or network.
- Payment, OTP and CAPTCHA always hand over to the human.
- Every action is verified; no fake success, no infinite loops, no `eval()`.
- Build in the order of spec §89 and hit milestones §90–95 one at a time.
- Preserve the existing Techie Mind UI look and feel (§4). Screenshots of the current UI live in [reference/UI_REFERENCE/](reference/UI_REFERENCE/) — match them when building UI.
