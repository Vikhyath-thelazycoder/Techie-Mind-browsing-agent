# Known Limitations

**Status:** Current as of Batch A — Phase 3 + 4 (2026-09-28).

## Phase 1 — agent core

1. **Synthetic input only.** Content scripts cannot create trusted user gestures. Consequences:
   - **Sound autoplay cannot be unlocked by the agent.** On a fresh Chrome profile, "Open YouTube and play some Kannada songs" opens a real video and then hands over ("Press Play") — verified live (P1). With a profile where autoplay is permitted (P2, `--autoplay-policy=no-user-gesture-required`, comparable to a user whose Chrome already allows YouTube autoplay) the full playback flow completes and is verified. A trusted-input path (e.g. `chrome.debugger` Input events) is a later-phase option with a visible permission trade-off.
   - Sites that ignore untrusted events for critical actions would not respond; none of the tested sites did.
2. **Supported goals:** navigate, search, open/play a result. Purchases, form filling, extraction and multi-site tasks are refused with `UNSUPPORTED_INTENT` (later phases), never improvised.
3. **Intent resolution is deterministic (Tier 0).** Unusual phrasings without a recognised command verb fall back to a generic web search of the whole text (confidence 0.5). *(Phase 3: these now go to Laya → the local model when configured; without models the behaviour is unchanged.)*
4. **Single top frame.** Grounding and execution cover the top document and open shadow roots; cross-origin iframes and closed shadow roots are not observed.
5. **Observation version drift is tolerated when the target is unchanged** (busy pages mutate constantly). Stale-action policy beyond target identity is part of the Phase 2 firewall.
6. **Live-site stability:** in 4 full runs of the 7 live search tests (28 executions), 27 passed and 1 failed with an undiagnosed cause (output not captured; not reproduced in 3 subsequent runs). Live sites change and may add bot checks; failures would be reported, not hidden.
7. **Latency:** ~95% of task time is the website loading/reacting; the settle rule (300 ms quiet windows) adds ~0.6 s per task on fixtures — optimisation deferred to Phase 12.
8. **Tab choice:** the agent reuses the active tab when it is a normal web page or a new tab; otherwise it opens a new tab.
9. **History entries** recorded before the `waitMs` timing field existed no longer validate and are not shown (pre-release data).

## Phase 2 — security + privacy

- Personal names are detected only with a cue (label, honorific, greeting, profile header); a bare name in a link label or title is not detectable by pattern (titles are therefore never logged).
- The privacy corpus is synthetic and templated (precision/recall 1.0 there); real-world precision/recall will be lower and should be re-measured on a labelled real sample (Phase 10).
- Text hidden with CSS is neither observed nor scanned; instructions in it cannot reach the agent, but they are also not counted.
- Confirmation-required (HIGH) actions end the task with a handover; an in-flow "confirm and continue" arrives with Phase 7 handover/resume.
- DNS rebinding cannot be fully excluded for cookieless GET probes (the browser resolves names).
- The audit log keeps the last 2,000 events locally; older records roll off behind a verifiable anchor.

## Batch A — Phase 3 (model routing) + Phase 4 (vision)

- **Not run against the real models in this batch.** Batch A was built in a cloud container without Laya or Ollama; all tier tests use stand-in servers speaking the real wire formats. Real latency and accuracy come from `npm run bench:models -- --vision` on the Mac.
- **Laya's raw output format is mapped defensively** (`interpret()` in the adapter). Any shape it does not recognise becomes an escalation. Run `laya_adapter.py --selftest` once on the Mac to confirm the mapping.
- **The in-browser vision path is not built.** The spec's preferred option (Florence-2 via Transformers.js / ONNX Runtime Web, WebGPU) is a documented comparison plan; the working fallback is the local `qwen2.5vl:7b` through Ollama.
- **Visual privacy is DOM-driven.** Text drawn inside images or canvas is not OCR-scanned; person photos are covered by DOM hints only (no face-detection model).
- **Vision sees the viewport only;** targets below the fold are not found until page commands (scroll) arrive.
- **Model-routed actions:** a model can resolve a request into open/search/play or pick one element on the page. Multi-step plans, forms and extraction arrive with Phases 5–6.
- **Price constraints are not sent to models** (constraint `value` keys are refused by the gate); code keeps them locally.

## Phase 1 correction

- Website resolution tries a bounded set of TLDs; a brand whose site is on an unrelated domain falls back to search discovery + handover.
- Lower-case "… on zara" is read as a site only with "website/site/app" or capitalisation; otherwise it stays in the query.
- In-tab confirmation briefly shows candidate pages in the task tab.
- Live Test C (Flipkart) failed once in 4 runs after the correction (honest handover, results were on screen; not reproduced in 3 reruns).
- The resolution cache lives only as long as the background worker.

## Carried from Phase 0

10. Firefox build lints clean but has not been run in a real Firefox (Playwright cannot load WebExtensions into Firefox). Planned for Phase 13.
11. Clicking the real toolbar icon is not automatable; tests verify `openPanelOnActionClick` and render the panel page directly.
12. Privacy settings are stored, not enforced, until Phase 2. Phase 1 sends nothing off the device: no model calls, no telemetry upload.
13. Model availability is not checked (Phase 3).
14. CI workflow exists but has not run on GitHub (no remote). Live-site tests are intentionally not in CI.
15. Product name follows the spec ("Techie Mind"); screenshots say "TechyMind" — awaiting confirmation.
16. `reference/UI_REFERENCE/Screenshot 2026-09-28 at 12.49.52 PM.png` contains personal data; keep `reference/` out of public repositories.
