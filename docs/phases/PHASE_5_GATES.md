# Gates: Phase 5 — Real Agent Workflows

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, package.json, package-lock.json

Scope: the generic pipeline carries real workflows end to end — result extraction with prices and
constraints, choosing by price, page commands (scroll, back), add-to-cart stopping before payment,
profile-based form filling through the vault, page summaries, and trusted clicks for media. No
site-specific code. Live-site acceptance (YouTube, Flipkart, Amazon) is the Phase 5 milestone and
runs on the owner's Mac (the cloud container cannot reach those sites).

- [x] G1: fast regression — all unit tests pass; Phase 3 and 4 gates still hold; no hard-coded
  acceptance phrases; only the privacy gate reaches the network
  CHECK: node scripts/verify/phase5.mjs regression
  EXPECT: PHASE5-VERIFY regression passed

- [x] G2: extraction — repeated items are extracted generically (title, price, currency, link
  element) from differently built result pages; prices in ₹/Rs/INR/$ with commas and lakh/k forms
  parse; "under ₹50,000" filters them; "the cheapest one" opens the cheapest — without a model
  CHECK: node scripts/verify/phase5.mjs extraction
  EXPECT: PHASE5-VERIFY extraction passed

- [x] G3: page commands — "scroll down", "go back" are executed and verified, never web-searched
  CHECK: node scripts/verify/phase5.mjs commands
  EXPECT: PHASE5-VERIFY commands passed

- [x] G4: ecommerce — add to cart is grounded generically, verified, and the agent stops before
  payment; checkout navigation is allowed; OTP/CVV/payment are never touched
  CHECK: node scripts/verify/phase5.mjs ecommerce
  EXPECT: PHASE5-VERIFY ecommerce passed

- [x] G5: forms — the profile is stored encrypted locally; fields are mapped by meaning; values are
  typed through vault tokens and verified; unknown, password, OTP and card fields are never filled;
  nothing is submitted without confirmation; no raw profile value appears in logs, history or
  model traffic
  CHECK: node scripts/verify/phase5.mjs forms
  EXPECT: PHASE5-VERIFY forms passed

- [x] G6: summaries and output — a page summary is built from locally extracted, redacted text
  (model when available, extractive otherwise); task output (items/text) reaches the side panel and
  history redacted
  CHECK: node scripts/verify/phase5.mjs output
  EXPECT: PHASE5-VERIFY output passed

- [x] G7: trusted media click — when available, the media result is opened with a trusted click so
  playback starts past the autoplay block, and playback is verified; without it the agent hands over
  exactly as before
  CHECK: node scripts/verify/phase5.mjs media
  EXPECT: PHASE5-VERIFY media passed

- [x] G8: real Chrome — the built extension runs the workflows on fixture sites (search → filter →
  cheapest, scroll, back, add to cart → stop at payment, fill form, summarize, trusted play) and
  every earlier real-Chrome test still passes
  CHECK: node scripts/verify/phase5.mjs browser
  EXPECT: PHASE5-VERIFY browser passed

**Result (2026-09-29, cloud container):** all gates pass — unit 430/430, real Chrome 55/56 (the one failure is the known container-only `sidePanel.getPanelBehavior`), lint/typecheck/prettier clean. Live-site milestone runs on the Mac.
