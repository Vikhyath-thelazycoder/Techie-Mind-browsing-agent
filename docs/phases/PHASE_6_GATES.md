# Gates: Phase 6 — All 12 Skills

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, package.json, package-lock.json

Scope: the 12 first-class skills of spec §30 — each with a manifest (Skill contract), intent
recognition (natural wording and `/skill-id`), a generic execution strategy on the Phase 5 pipeline,
privacy and security policy, verification, failure handling, UI progress and tests.
monitor-page stores the monitor definition locally; the persistent backend scheduler is Phase 8
(Batch C) and is not claimed here.

- [ ] G1: fast regression — all unit tests pass; Phase 3–5 gates still hold; only the privacy gate
  reaches the network
  CHECK: node scripts/verify/phase6.mjs regression
  EXPECT: PHASE6-VERIFY regression passed

- [ ] G2: skill matrix — 12 manifests validate against the Skill contract; every skill declares
  inputs, risk, permissions, verification and failure handling, and has intent phrases, an
  executor and at least one passing test
  CHECK: node scripts/verify/phase6.mjs matrix
  EXPECT: PHASE6-VERIFY matrix passed

- [ ] G3: page skills — summarize-page, extract-data (items or tables, optional CSV/JSON export),
  screenshot-walkthrough (redacted capture with numbered regions) work on the open page
  CHECK: node scripts/verify/phase6.mjs page
  EXPECT: PHASE6-VERIFY page passed

- [ ] G4: multi-source skills — compare-prices (≥2 named sites, normalized, cheapest per site),
  find-alternatives (excludes the item itself, applies constraints), deep-research (several sources,
  extracted evidence, citations) — never inventing unavailable information
  CHECK: node scripts/verify/phase6.mjs research
  EXPECT: PHASE6-VERIFY research passed

- [ ] G5: browser skills — manage-bookmarks, organize-tabs, read-later, save-page, monitor-page use
  browser APIs through the host; destructive steps only on explicit request and never on pinned,
  active or unrelated items; stored data keeps URLs without query strings
  CHECK: node scripts/verify/phase6.mjs browser-apis
  EXPECT: PHASE6-VERIFY browser-apis passed

- [ ] G6: real Chrome — skills run in the built extension (bookmark, group tabs, read later, save
  page, compare prices on two fixture stores, research, walkthrough) and every earlier real-Chrome
  test still passes
  CHECK: node scripts/verify/phase6.mjs browser
  EXPECT: PHASE6-VERIFY browser passed

- [ ] G7: docs — SKILLS.md documents the 12 skills (inputs, strategy, privacy, security,
  verification, failure) and the skill matrix
  CHECK: node scripts/verify/phase6.mjs docs
  EXPECT: PHASE6-VERIFY docs passed
