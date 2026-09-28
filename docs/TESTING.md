# Testing

**Status:** Phase 1 — unit, integration (virtual site), real-Chromium (shell, agent on fixture sites, security, latency) and live-site acceptance layers implemented.

## Commands

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over every package, app, test and config |
| `npm run lint` / `npm run format:check` | ESLint (security rules as errors) / Prettier |
| `npm test` | Vitest unit suites (`packages/*/test`, `apps/*/test`) |
| `npm run build` | Chrome + Firefox extension builds |
| `npm run lint:firefox` | Mozilla `web-ext lint` on the Firefox build |
| `npm run test:browser` | Playwright project `browser`: built extension in real Chromium — shell, agent on local fixture sites, security regressions, latency (no network) |
| `npm run test:live` | Playwright project `live`: acceptance + variations + playback on live youtube.com / flipkart.com (needs internet) |
| `npm run verify` | All Phase 2 acceptance gates (`scripts/verify/phase2.mjs all`); `npm run verify:phase1` / `verify:phase0` for regression |
| `npm run verify:phase0` | Phase 0 gates (regression) |

## Acceptance gates

Each phase has a gate ledger (`docs/phases/PHASE_N_GATES.md`) written **before** implementation (Unlazy method). Every runnable gate calls a repository verifier that inspects structured tool output (Vitest JSON, Playwright JSON, web-ext JSON, the built manifest) and prints a success marker only after all assertions pass.

## Rules

- A test that fails is diagnosed and fixed at the root cause — never skipped, weakened, or hard-coded.
- Negative checks get a positive control (e.g. the HTML-injection lint rule was verified to fire on a probe).
- Evidence (screenshots, latency JSON, live results) is written to `evidence/` — not `test-results/`, which Playwright wipes on every run.
- Live-site tests verify the resulting page **independently** of the agent's own report (URL, query parameter, search-field value, visible result links, media element state).
- A test that proves an absence carries a positive control (e.g. the hard-coding scanner is shown to find the phrases in the test files; the race regression test is shown to fail against the old code).

## Layers (Phase 1)

| Layer | Where | What it proves |
|---|---|---|
| Unit | `packages/*/test`, `apps/extension/test` | contracts, intent (25+ phrasings incl. Hinglish/Kannada), routing, grounding with decoys, verification incl. preview-player trap, executor binding checks (JSDOM), content/host/task-service trust boundaries |
| Integration | `packages/agent-core/test/runner.test.ts` + `virtual-site.ts` | the runner's control flow and every recovery level against a scripted site |
| Real browser | `tests/browser/*.spec.ts` | the built extension in Chromium: 9 agent scenarios on fixture sites, security regressions, latency |
| Live | `tests/live/*.spec.ts` | acceptance tests A–C, 4 variations, playback on the real websites |

## Layers (Phase 1 correction)

| Layer | Where | What it proves |
|---|---|---|
| Unit | `agent-core/test/navigation.test.ts`, `website.test.ts` | 38 wordings → targetSource/navigationPolicy; priority rules; resolution scoring on real-shaped probes |
| Integration | `agent-core/test/runner.test.ts` | reuse, continuity, Nth result, resolution, in-tab confirmation, ambiguity, last resort, CAPTCHA handover |
| Real browser | `tests/browser/context.spec.ts` | 12 scenarios with a network guard (positive control) — nothing leaves the fixtures |
| Live | `tests/live/correction.spec.ts` | A–I + J variants; live browser uses the normal Chrome user agent (headless UA is blocked by some sites) |

Gates: `node scripts/verify/phase1.mjs <policy|resolution|context|correction-live|correction-variants|correction-docs>` ([ledger](phases/PHASE_1_CORRECTION_GATES.md)).

## Layers (Phase 2)

| Layer | Where | What it proves |
|---|---|---|
| Unit | `packages/privacy/test/privacy.test.ts` | checksums, 18 detection kinds + look-alike negatives, DOM semantics, labelled corpus metrics → `evidence/privacy-metrics.json`, vault lifecycle, sanitized observation has no raw value, gate blocks/allows |
| Unit | `packages/security/test/firewall.test.ts` | 10 checks in order, 12 binding/stale/origin rejections with positive controls, payment/OTP/CAPTCHA/login handover, privacy and provenance, risk classes |
| Unit | `packages/telemetry/test/telemetry.test.ts` | persisted hash chain, tamper/delete/reorder detection, bounded ring anchor, key-order independence |
| Integration | `packages/agent-core/test/runner.test.ts` | firewall in the loop, injection ignored, payment stop, PII counts without values |
| Real browser | `tests/browser/adversarial.spec.ts` | injection site, payment result, PII page leak scan (events, storage, audit, network) with positive control, audit across tasks |

Gates: `node scripts/verify/phase2.mjs <correction-regression|detection|vault|gate|firewall|adversarial|audit|performance|docs|all>` ([ledger](phases/PHASE_2_GATES.md)).
