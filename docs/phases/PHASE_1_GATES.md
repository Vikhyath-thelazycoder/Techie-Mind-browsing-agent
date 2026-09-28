# Gates: Phase 1 — Real Browser Agent Core

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, playwright.config.ts, vitest.config.ts, package.json, package-lock.json, CLAUDE.md, README.md

Scope: one generic deterministic pipeline — intent → direct routing → navigation → DOM/A11y observation → semantic grounding → bound typed action → execution through the BrowserAdapter → result observation → verification → bounded recovery — proven in real Chromium on local fixtures and on live YouTube and Flipkart, with no request-specific code.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/vikhyathmgowda007/Developer/eos-capabilities/unlazy/scripts/gate-lint.mjs docs/phases/PHASE_1_GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=ee626fcbde381b93c6ce1937ded7d2b47d1bf7f0e5b38634e9a6a3853176ea2c; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G1: every Phase 0 acceptance gate still passes (regression)
  CHECK: node scripts/verify/phase0.mjs all
  EXPECT: PHASE0-VERIFY ALL 8 passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=624a4ab3e1c468a107c019486becf7628fabffa8983357863dd54ed529979b70; exit=0; EXPECT=matched; output-sha256=1f3d41c52fb50a36d745625f03c4ddc8e96546c07ad35d9cf903a9a7974f87dd; output-bytes=534; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G2: the workspace type-checks and ESLint and Prettier report zero problems
  CHECK: node scripts/verify/phase1.mjs static
  EXPECT: PHASE1-VERIFY static passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fd6d90ca337f3a73f27d19d8c74bca4d2b2f19a8ef03e3c55f55b209580c0d9e; exit=0; EXPECT=matched; output-sha256=8db5d09c6faf68cbde379cc052cf8e47ed0ba8879252da21a016d7517db9156c; output-bytes=28; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G3: unit and integration suites for intent, routing, perception, grounding, binding, verification, recovery and the runner all execute and pass
  CHECK: node scripts/verify/phase1.mjs unit
  EXPECT: PHASE1-VERIFY unit passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=52b77182533ac136779c8e2fda7e8280aa7ed5eb802dd28e92332579eb531a89; exit=0; EXPECT=matched; output-sha256=ad915663fd83f389b7ebd559ccb52eab4789aa300334eb9c172609e6edbd7e04; output-bytes=59; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G4: no acceptance phrase or query is hard-coded in runtime source, and more than ten differently worded requests resolve to correct structured intents
  CHECK: node scripts/verify/phase1.mjs generic
  EXPECT: PHASE1-VERIFY generic passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0c1c8f2189022d98c33c9972dbb5e27b90feb28f5eda15c4a1f3845c604742ac; exit=0; EXPECT=matched; output-sha256=effe774cd509175276bacbd1f05f5e8c1b4c7e32fc1c1d2007a3ee38c1dd6aeb; output-bytes=93; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G5: in real Chromium the agent completes every local-fixture scenario (form search, script-driven search, hidden search toggle, re-rendered target, button-only submit, open and play result) and honestly fails a page with no search
  CHECK: node scripts/verify/phase1.mjs fixtures
  EXPECT: PHASE1-VERIFY fixtures passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=337204530ddc7289ce536fd33aa617e8588729d46e2bdbdb2a7dc3c0710ebb0c; exit=0; EXPECT=matched; output-sha256=3abdd4d795eacd8be7dd9008380b02d0a4fd0770e0ea26fed66ede10bc796cbc; output-bytes=81; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G6: acceptance tests A, B and C complete on live youtube.com and flipkart.com, independently verified by URL, search-field value and visible results
  CHECK: node scripts/verify/phase1.mjs acceptance
  EXPECT: PHASE1-VERIFY acceptance passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8a17fa2007170d1f0cb1fdfacea107022d03c7dffa6a0984e9612fb3d37f8f63; exit=0; EXPECT=matched; output-sha256=4030eabdc39f7c8de804810bbcdf803d24130988589a055e552439964062c4c9; output-bytes=103; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G7: at least three additional live-site variations with different wording, queries or language complete without code changes
  CHECK: node scripts/verify/phase1.mjs variations
  EXPECT: PHASE1-VERIFY variations passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1567e69a2aade345f2791bc7b86fef7f4eaa03fd4991a4fdc4cbf7fea3514bfb; exit=0; EXPECT=matched; output-sha256=8290c964b0642dfdba9dd84984a8cd7f039c43b01bdfad00aa02436725d3a93d; output-bytes=71; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G8: per-stage latency (intent, navigation, observation, grounding, action, verification, total) is measured and recorded as evidence
  CHECK: node scripts/verify/phase1.mjs performance
  EXPECT: PHASE1-VERIFY performance passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f38465cc0a070b1d693465c7693fa4f466cbc00171b56f7075db09730f55dce8; exit=0; EXPECT=matched; output-sha256=6efc16ecc6917fe167239bb3e642589c0cb88d8ad20d59f7150bf02f997fe1e3; output-bytes=86; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G9: security regressions for the new actions pass: unbound, mismatched, stale, unsupported and malformed actions and untrusted task senders are rejected in real Chromium
  CHECK: node scripts/verify/phase1.mjs security
  EXPECT: PHASE1-VERIFY security passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e7690f36fc429367ce17ccff551e0851d5a26e60bfcf72c87dfc0c84ded6b125; exit=0; EXPECT=matched; output-sha256=5d238dc6d349ea37884e267652690b7209d4503569719fbdf0fa5b343d7c3058; output-bytes=86; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G10: documentation reflects Phase 1 (status, architecture, perception, performance, limitations, report)
  CHECK: node scripts/verify/phase1.mjs docs
  EXPECT: PHASE1-VERIFY docs passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d709fc4c7d8072d8995c9e8b1e346c73e557ef14a547146ed799566cd13438f; exit=0; EXPECT=matched; output-sha256=50f412d142bb5c03bb1838b4b7b83030458c9541bd966107634e8c306c161c02; output-bytes=121; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries
