# PHASE 1 — COMPLETION REPORT

**Status:** COMPLETE — 2026-09-28. Gate ledger: [PHASE_1_GATES.md](PHASE_1_GATES.md) (Unlazy `gate-check`, all gates met; Phase 0 regression gate included).

## 1. Phase objective
Build the real, generic, deterministic browser-agent core on the Phase 0 architecture: user request → intent → direct routing → navigation → DOM/A11y observation → semantic grounding → structured, bound action → execution through the BrowserAdapter → result observation → verification → bounded recovery — proven on live YouTube and Flipkart without request-specific code.

## 2. What was implemented
- Tier-0 deterministic **intent resolver** (clause-based; English, Hinglish, romanised Kannada; price constraints; original-case query recovery).
- **Direct domain routing** for 11 known sites and any explicit domain; Google only when no site is named.
- **Planner** producing generic goals (navigate / search / open-result).
- **DOM observer** (open shadow roots, geometry, visibility, forms, landmarks) and computed **accessibility projection**.
- **Semantic grounding** for search fields, submit controls, collapsed-search toggles and result links — explainable scores, no selectors.
- **Action binding** to task, observation, document, tab, origin, target (+ fingerprint) and version; re-checked in the page before execution.
- **Browser executor**: CLICK, TYPE (+ implicit submit), CLEAR, SELECT, SCROLL, PRESS_KEY, FOCUS, HOVER, HIGHLIGHT in the page; NAVIGATE and history-back through the BrowserAdapter; visible activity overlay.
- **Verification**: navigation host, field value, search results visible for the query, sustained media playback.
- **Bounded recovery** L1–L6 with typed `RecoveryDecision`s; step budget and task timeout.
- **Structured telemetry**: §60 events streamed live; per-stage timings in every `TaskResult`.
- **UI integration**: plan preview (Ask before acting), live timeline, result card, real History with Copy/Rerun.

## 3. Files created
`packages/agent-core/**` (text, sites, intent, router, plan, grounding, verify, binding, host, runner + 6 test files incl. `virtual-site.ts`); `packages/perception/**` (accessibility, registry, observer, overlay, executor + tests and JSDOM helper); `packages/contracts/src/agent.ts`, `fingerprint.ts`; `apps/extension/src/background/host.ts`, `tasks.ts`; `apps/extension/src/sidepanel/task-client.ts`, `activity.tsx`, `history.tsx`; `apps/extension/test/content.test.ts`, `host-and-tasks.test.ts`; `tests/browser/sites.ts`, `agent-helpers.ts`, `agent.spec.ts`, `security.spec.ts`, `agent-performance.spec.ts`; `tests/live/live-helpers.ts`, `acceptance.spec.ts`, `playback.spec.ts`; `scripts/verify/phase1.mjs`; `docs/phases/PHASE_1_GATES.md`, this report; `evidence/` (screenshots, latency and live JSON).

## 4. Files modified
Contracts (`perception.ts` formId/value + derived attributes, `action.ts` nullable origin for NAVIGATE only + `ACTION_TYPES`, `messages.ts` content protocol, `index.ts`); `packages/browser` (tabs/scripting/ports); `packages/config` (`SETTINGS_STORAGE_KEY`); extension manifest (on-demand injection: `scripting` + host permissions, no `content_scripts`), background index, content script and handler, side panel `App.tsx` + CSS; Phase 0 tests updated for the deliberate injection change; `scripts/verify/phase0.mjs` (no-per-page-script assertion, browser project, summary marker); `playwright.config.ts` (browser/live projects); `package.json` scripts; docs (ARCHITECTURE, TECHNICAL_DESIGN, PERCEPTION, PERFORMANCE, SECURITY, TESTING, BROWSER_SUPPORT, MODEL_ROUTING, ACTION_FIREWALL, MULTILINGUAL, KNOWN_LIMITATIONS, IMPLEMENTATION_STATUS). Removed: Phase 0 dependency-free guard (superseded).

## 5. Agent architecture
`runTask` (agent-core) owns the loop and depends only on the `AgentHost` interface; `ExtensionHost` implements it over the Phase 0 `BrowserAdapter` and the contract-validated content protocol. Each goal runs observe → ground → bind → execute → settle → verify, with a per-goal `RecoveryLadder`. See [ARCHITECTURE.md](../ARCHITECTURE.md).

## 6. Intent-resolution architecture
Normalise → strip politeness → find site mention (known-site domain > alias > other explicit domain) → extract price constraints → find the primary command verb (prefix: search/look up/find/play/watch…; postfix, clause-final: search maadu/dhoondo/chalao/play maadi…) → take the query from the verb's side → remove the site with its prepositions/postpositions → trim edge filler → restore original casing. Purchases are marked HIGH risk and refused by the planner. 0 model calls.

## 7. Browser-execution architecture
Background: navigation (`tabs.update`, http(s) only), history back, on-demand injection (`scripting.executeScript`), cross-tab refusal, settle (wait for change, then load complete + DOM quiet). Page: `executeAction` re-checks the binding, highlights the target, then performs the primitive with standards-shaped synthetic events; navigation-capable effects run after the response is delivered (150 ms, so the highlight is visible).

## 8. DOM/A11y perception
See [PERCEPTION.md](../PERCEPTION.md): shadow-DOM-aware observer, computed ARIA roles/names/states/landmarks, stable element ids, per-document ids, mutation-driven version, fingerprints; 1,500-node cap.

## 9. Semantic grounding
Explainable scoring over the observation for search fields (with decoy exclusion: e-mail, login, PIN, OTP, newsletter), submit controls (same form, adjacency; voice/clear/lens excluded), search toggles, and results (query-term overlap with plural folding, outside page chrome). No selectors or per-site code; the verifier scans runtime source for acceptance phrases.

## 10. Verification/recovery
Verification is evidence-based: host match; field value; search = URL/title carries the query **and** relevant results are visible (re-observed up to 6 s); playback = sustained playback of the primary player. Recovery: L1 retry, L2 refresh observation, L3 re-ground after a stale/changed target, L4 next candidate, L5 alternative strategy (reveal collapsed search, submit via button, press Play), L6 handover — capped, typed, and reported.

## 11. UI integration
Composer runs tasks; "Ask before acting" (default) shows a local plan preview with Run/Cancel; the timeline streams real events with timestamps; the result card shows status, verified steps with evidence, total time and model-call count; History lists real results with Copy/Rerun. Evidence: `evidence/phase1-sidepanel-run.png`, `phase1-sidepanel-history.png`.

## 12. Exact tests executed
`node scripts/verify/phase0.mjs all`; `node scripts/verify/phase1.mjs <static|unit|generic|fixtures|acceptance|variations|performance|security|docs>` (runs `tsc --noEmit`, `eslint . --max-warnings=0`, `prettier --check .`, `vitest run --reporter=json`, `tsx apps/extension/scripts/build.ts`, `playwright test --project=browser …`, `playwright test --project=live -g …`); `npx playwright test --project=live tests/live/playback.spec.ts` (exploratory); all driven by `node ~/Developer/eos-capabilities/unlazy/scripts/gate-check.mjs --approve --cwd . --root . --timeout 900 docs/phases/PHASE_1_GATES.md`.

## 13. Test results
| Suite | Result |
|---|---|
| Phase 0 regression (8 gates) | PASS |
| Typecheck / ESLint / Prettier | PASS (0 problems) |
| Unit + integration (Vitest) | PASS 189/189 in 15 files |
| Real Chromium (`browser` project) | PASS 21/21 (shell 8, agent 9, security 2, latency 2) — stable over 4 consecutive runs after the race fix |
| Live (`live` project) | PASS 9/9 (acceptance 3, variations 4, playback P1 + P2) |
| Unlazy gate ledger | ALL MET 11/11, re-verified on final code (first pass: 9/11 — G4 flagged an acceptance phrase used as an example in a doc comment in `intent.ts`, reworded; G10 was a regex bug in the verifier's status check, fixed) |

## 14. Real browser results
Fixture scenarios in real Chromium (all PASS): form search with decoys; different wording/query; script-driven search without a form behind a login overlay; collapsed search (L5 reveal); re-mounted field (L3 re-ground); button-only submit (L5); play request with sustained-playback verification; page without search → honest HUMAN_REQUIRED; full side-panel flow with plan, timeline, result and history. Live results in §15.

## 15. Acceptance-test results
| Test | Request | Result | Independent evidence (live site) |
|---|---|---|---|
| **Test A** | "Open YouTube and search for Kannada songs." | **PASS** | www.youtube.com/results?search_query=Kannada+songs · field "Kannada songs" · ≥20 visible matching results · ~2.7–3.1 s |
| **Test B** | "Open YouTube and search for Python tutorials." | **PASS** | /results?search_query=Python+tutorials · field matches · ≥44 matching results · ~2.7–2.9 s |
| **Test C** | "Open Flipkart and search for running shoes." | **PASS** | www.flipkart.com/search?q=running shoes · field matches · "Showing 1–40 of 7,448 results" (screenshot) · ~3.1–3.5 s |
| V1 | "go to youtube and look up lo-fi beats for studying" | PASS | /results, query + field match |
| V2 | "YouTube par carnatic violin search karo" (Hinglish) | PASS | /results, query + field match |
| V3 | "Search Flipkart for steel water bottle" | PASS | /search, query + field match |
| V4 | "Flipkart alli bluetooth headphones search maadu" (Kannada code-switch) | PASS | /search, query + field match |
| P1 (exploratory) | "Open YouTube and play some Kannada songs" — fresh profile | PASS as designed: HUMAN_REQUIRED "Press Play" | opened /watch; browser blocked autoplay; no false success |
| P2 (exploratory) | same — autoplay-permitted profile | PASS | /watch, video playing (position 2.3 s), sustained-playback verified |

## 16. Performance measurements
0 model calls in every task. Fixtures (20 tasks): total P50 1,039 ms / P95 1,050 ms; intent 0.2 ms, observation 4.6 ms, grounding < 0.1 ms, action 2.5 ms, verification 0.1 ms, page wait 610 ms, navigation 418 ms. Live (7 search tasks): total median 2,731 ms (2,510–3,642); intent 5.3 ms, navigation 1,533 ms, observation 38 ms, grounding 0.4 ms, action 10.8 ms, verification 1.9 ms, page wait 1,012 ms. Full tables: [PERFORMANCE.md](../PERFORMANCE.md).

## 17. Security validation
Real Chromium (with positive control): content script rejects forged document id, foreign origin, future version, unknown element, swapped identity (fingerprint), page-side NAVIGATE, vault tokens, detached target, `javascript:` navigation, script actions and raw EVAL messages; decoy fields untouched; web pages cannot reach the runtime; task port rejects malformed requests. Unit: cross-tab refusal, untrusted port senders, contract re-validation, http(s)-only navigation, step budget, purchase refusal. See [SECURITY.md](../SECURITY.md).

## 18. Known limitations
See [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md). Main items: synthetic input cannot unlock sound autoplay (agent hands over); only navigate/search/open-result goals; deterministic intent only (Phase 3 adds models); top frame + open shadow roots only; one undiagnosed live failure in 28 executions (not reproduced); settle rule dominates latency; Firefox not yet run in a real browser.

## 19. Any external blockers
None blocking Phase 1. Environmental constraint recorded: Chrome's autoplay policy requires a trusted user gesture that an extension cannot synthesise (handled by handover). Live tests need internet and depend on third-party sites that can change or add bot checks.

## 20. Phase status
COMPLETE
