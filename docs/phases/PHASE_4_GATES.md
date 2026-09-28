# Gates: Phase 4 — Visual Perception

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, package.json, package-lock.json

Scope: perception level 4 — an on-demand visual fallback. Vision is invoked only when DOM /
accessibility / semantic grounding cannot find the target; the visible tab is captured, sensitive
regions are redacted locally before any model sees the image, a local vision model returns a
structured region (never an action), the region is grounded back to a DOM element, and the action on
that element passes the same firewall. Benchmarked on the owner's Mac with `npm run bench:models --
--vision`.

Environment: built in a cloud container without Ollama. Gates run against a stand-in vision server
speaking Ollama's wire format. The in-browser WebGPU/WASM candidate (Florence-2 via
Transformers.js / ONNX Runtime Web) is evaluated as a comparison plan only in this batch; it is not
claimed here.

- [x] G1: fast regression — all unit tests pass, Phase 3 gates still pass, only the privacy gate
  reaches the network
  CHECK: node scripts/verify/phase4.mjs regression
  EXPECT: PHASE4-VERIFY regression passed

- [x] G2: vision only when needed — a page code can ground makes 0 vision calls and 0 captures;
  vision runs only after grounding finds nothing on a page with visual-only elements (unnamed
  controls, images, canvas); a text-only page never triggers it
  CHECK: node scripts/verify/phase4.mjs lazy
  EXPECT: PHASE4-VERIFY lazy passed

- [x] G3: local visual privacy — before an image leaves the host, every region holding detected
  personal data, password/card/OTP fields and person photos is painted over; the gate accepts images
  only for visual grounding, only marked redacted, bounded in size, and never scans them as text
  CHECK: node scripts/verify/phase4.mjs privacy
  EXPECT: PHASE4-VERIFY privacy passed

- [x] G4: structured regions only — vision answers parse strictly into a box inside the image; the
  box maps to page coordinates and to the best-overlapping visible interactive DOM element, or to
  nothing (then hand over) — never a coordinate click
  CHECK: node scripts/verify/phase4.mjs grounding
  EXPECT: PHASE4-VERIFY grounding passed

- [x] G5: the visual fallback completes tasks through the firewall — a result with no accessible name
  is opened via vision; a payment control located by vision is handed over; an injected element
  located by vision is blocked
  CHECK: node scripts/verify/phase4.mjs runner
  EXPECT: PHASE4-VERIFY runner passed

- [x] G6: real Chrome — the built extension captures the tab, redacts it (checked pixel by pixel in
  what the stand-in received), opens the visually located item, and every earlier real-Chrome test
  still passes
  CHECK: node scripts/verify/phase4.mjs browser
  EXPECT: PHASE4-VERIFY browser passed

- [x] G7: benchmark and docs — the vision benchmark set (rendered fixture, ground-truth boxes,
  accuracy/latency/memory) exists and runs; PERCEPTION.md documents level 4, triggers, privacy and
  the in-browser comparison plan
  CHECK: node scripts/verify/phase4.mjs docs
  EXPECT: PHASE4-VERIFY docs passed

**Result (2026-09-28, cloud container, `TM_CHROMIUM=/opt/pw-browsers/chromium`):** PHASE4-VERIFY all 7 gates passed (regression re-run after correcting the test-count floor to the actual 387). Real-Chrome suite 43/44 — the one failure is environment-only (this Chromium build lacks `chrome.sidePanel.getPanelBehavior`), matched exactly by the verifier and printed.
