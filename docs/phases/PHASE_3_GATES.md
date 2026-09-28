# Gates: Phase 3 — Model Routing

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, package.json, package-lock.json

Scope: tiered intelligence (Code → Laya → local Qwen / configured API → handover), one model
configuration, strict model contracts, privacy-gated model transport, the persistent Laya adapter,
and per-tier latency. Models only interpret; code re-checks, the firewall authorizes. No vision
(Phase 4), no new workflows or skills (Phase 5/6).

Environment: built in a cloud container without Laya or Ollama. Every gate below runs against
stand-in servers that speak the real wire formats. The real-model benchmark
(`npm run bench:models`) runs on the owner's Mac and is reported separately — it is not claimed
here.

- [x] G1: fast regression — all unit tests pass, no hard-coded acceptance phrases, and only the
  privacy gate reaches the network (model clients included)
  CHECK: node scripts/verify/phase3.mjs regression
  EXPECT: PHASE3-VERIFY regression passed

- [x] G2: model contracts are strict — Laya classifications and model interpretations parse only
  from well-formed JSON with known fields and bounded values; anything else is an `invalid`
  outcome that is never acted on
  CHECK: node scripts/verify/phase3.mjs contracts
  EXPECT: PHASE3-VERIFY contracts passed

- [x] G3: routing order holds — confident code makes 0 model calls; uncertain commands go to Laya
  first; Laya escalation or low confidence goes to the active model; an abstaining model hands
  over with a clarifying question; unavailable models fall back to the code result with a visible
  event; the configured model is never swapped for another
  CHECK: node scripts/verify/phase3.mjs routing
  EXPECT: PHASE3-VERIFY routing passed

- [x] G4: privacy — every model request is a ModelRequest that passed the outbound gate; the page
  summary carries no field values, no query strings and no raw DOM; personal data in the page or
  the user's words reaches the model only as vault tokens
  CHECK: node scripts/verify/phase3.mjs privacy
  EXPECT: PHASE3-VERIFY privacy passed

- [x] G5: authority stays local — a model answer naming a query not in the user's words, an
  element not in the observation, an injected element, or a payment control is refused by code or
  the firewall, never executed
  CHECK: node scripts/verify/phase3.mjs authority
  EXPECT: PHASE3-VERIFY authority passed

- [x] G6: model-routed commands complete end to end in the runner — natural follow-ups the code
  cannot parse ("open the samsung one", "I want to hear something by Arijit Singh") finish with
  verified steps, recorded tier and latency
  CHECK: node scripts/verify/phase3.mjs runner
  EXPECT: PHASE3-VERIFY runner passed

- [x] G7: the Laya adapter is persistent, authenticated and bounded — health endpoint, token
  check, request-size limit, typed answers; exercised live in fake mode
  CHECK: node scripts/verify/phase3.mjs laya-adapter
  EXPECT: PHASE3-VERIFY laya-adapter passed

- [x] G8: real Chrome — the built extension routes an unparseable follow-up through Laya and the
  local model (stand-in servers), completes it on the open site, sends no personal data, and every
  earlier real-Chrome test still passes
  CHECK: node scripts/verify/phase3.mjs browser
  EXPECT: PHASE3-VERIFY browser passed

- [x] G9: docs — MODEL_ROUTING.md describes tiers, thresholds, timeouts, privacy and fallbacks;
  the benchmark script exists
  CHECK: node scripts/verify/phase3.mjs docs
  EXPECT: PHASE3-VERIFY docs passed

**Result (2026-09-28, cloud container, `TM_CHROMIUM=/opt/pw-browsers/chromium`):** PHASE3-VERIFY ALL 9 passed. Real-Chrome suite 43/44 — the one failure is environment-only (this Chromium build lacks `chrome.sidePanel.getPanelBehavior`), matched exactly by the verifier and printed.
