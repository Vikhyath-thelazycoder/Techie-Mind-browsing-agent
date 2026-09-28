# Batch A — working checklist (Phase 3 + Phase 4)

Re-read this file after any context compaction. Tick an item only when its test passes.

Environment notes:
- This batch was built in a cloud container: no Laya, no Ollama. Model tiers are tested against
  local stand-in HTTP servers that speak the real wire formats (Ollama `/api/chat`, the Laya adapter
  `/v1/classify`). Real-model runs happen on the owner's Mac with `npm run bench:models`.
- Real-Chrome tests here: `TM_CHROMIUM=/opt/pw-browsers/chromium npm run test:browser`.
  Baseline 38/39 — `toolbar button is bound to the side panel` fails only because the container's
  Chromium build lacks `chrome.sidePanel.getPanelBehavior` (environmental, not a code bug).
- Model decision: `qwen2.5vl:7b` (already installed) serves text and vision; name stays one setting.

## Phase 3 — Model routing
- [x] Gates written: `docs/phases/PHASE_3_GATES.md` + `scripts/verify/phase3.mjs`
- [x] Contracts: model tier result/telemetry (`TaskResult.models`), `modelMs` timing
- [x] Page summary for models: sanitized, bounded, interactive-first (no raw DOM, no values)
- [x] Laya client (typed choices, abstain, token auth, timeout, bounded size) + adapter server script
- [x] Qwen client (Ollama `/api/chat`, JSON format, strict parse, timeout, availability check)
- [x] Router: Code → Laya → Qwen → handover; never silent substitution; latency per tier
- [x] Runner integration: low-confidence/unknown commands go to models; model proposals become
      intents/goals; firewall still authorizes every action
- [x] Extension wiring: model calls through `gatedFetch` (purpose `model`), settings default model
- [x] Unit tests (router, clients, summary, runner with stand-in models)
- [x] Real-Chrome test with stand-in model servers (follow-up that code cannot parse)

## Phase 4 — Visual perception
- [x] Gates written: `docs/phases/PHASE_4_GATES.md` + `scripts/verify/phase4.mjs`
- [x] Insufficiency detector: vision only when DOM/A11y grounding fails
- [x] Screenshot capture (visible tab) → local redaction of sensitive regions before the model
- [x] Vision client (Ollama qwen2.5vl) → structured `VisualRegion`s (no control)
- [x] Region → DOM node grounding; action still bound to a DOM element and firewall-checked
- [x] Benchmark script (`npm run bench:models`) + evidence JSON
- [x] Unit tests + real-Chrome test (canvas/icon-only page where DOM grounding fails)

## Wrap-up
- [x] lint, typecheck, unit, browser, verify (final run)
- [x] `docs/phases/BATCH_A_REPORT.md`, IMPLEMENTATION_STATUS (MODEL_ROUTING, PERCEPTION, TECHNICAL_DESIGN, KNOWN_LIMITATIONS, README done)
