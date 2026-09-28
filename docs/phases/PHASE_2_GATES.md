# Gates: Phase 2 — Security + Privacy

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, playwright.config.ts, vitest.config.ts, package.json, package-lock.json, tsconfig.json, CLAUDE.md, README.md

Scope: local privacy engine (layered PII/secret detection with checksums, redaction, memory-only token vault, sanitized observations), an outbound privacy gate every network request must pass, the full action firewall (schema → task/tab binding → target → origin → freshness → risk → privacy → injection/provenance → authorization) in front of every agent action, prompt-injection defense, financial/OTP/CAPTCHA handover, and a tamper-evident persisted audit log — proven by adversarial and privacy tests in unit, corpus and real-Chromium form. No model routing, vision, skills or monitoring.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/vikhyathmgowda007/Developer/eos-capabilities/unlazy/scripts/gate-lint.mjs docs/phases/PHASE_2_GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=8d1b77a1f071969b40d116fadbaea8deff2be2d2e13690e3e53b56003cd1e480; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G1: every Phase 0 acceptance gate still passes (regression)
  CHECK: node scripts/verify/phase0.mjs all
  EXPECT: PHASE0-VERIFY ALL 8 passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=624a4ab3e1c468a107c019486becf7628fabffa8983357863dd54ed529979b70; exit=0; EXPECT=matched; output-sha256=52c2bd2fab4af0e5d269566d1a8a8587d5123dc68faa00b0abfc02a752ef8b8f; output-bytes=535; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G2: every original Phase 1 gate still passes with the firewall and privacy engine in the loop (static, unit, generic, fixtures, live A–C, variations, performance, security, docs)
  CHECK: node scripts/verify/phase1.mjs all
  EXPECT: PHASE1-VERIFY ALL 9 passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b12b9df72310c1ea28a188b4deeb3815dcb69d19fb57cb482b4dad83676ed4ce; exit=0; EXPECT=matched; output-sha256=8c3117b9cc3c1322cd5c7fabecab09f30eb1393e78be6dfd4882ccf4711eb543; output-bytes=755; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G3: the Phase 1 correction still holds with the firewall in the loop (navigation policy, resolution scoring, real-Chromium context scenarios)
  CHECK: node scripts/verify/phase2.mjs correction-regression
  EXPECT: PHASE2-VERIFY correction-regression passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=860bcae596a026a2ca14be0b3d887c8edee927518b2a57d700a303618eb9ef73; exit=0; EXPECT=matched; output-sha256=420dd38a160babb3dc41fcfb58d0c373de17bba481bba7aa7fa5142eaf4252e6; output-bytes=138; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G4: layered detection finds every sensitive kind of the spec privacy test (name, e-mail, phone, Aadhaar, PAN, password, card) plus Indian financial/identity and secret kinds, validates Aadhaar/card/GSTIN checksums, rejects look-alikes, and reaches precision ≥ 0.95 and recall ≥ 0.95 on the labelled synthetic corpus
  CHECK: node scripts/verify/phase2.mjs detection
  EXPECT: PHASE2-VERIFY detection passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=47bc700f1b2f7ea66b7648782e2eab7694391176b9cf1ea65da4f0bca455d329; exit=0; EXPECT=matched; output-sha256=c334cc9f50dae8b563ca8c344c88358d5aa8348a397d683063419836942f6645; output-bytes=120; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G5: the token vault is memory-only, bounded, TTL-expiring, single-use, vault-scoped and never serializes or logs a value
  CHECK: node scripts/verify/phase2.mjs vault
  EXPECT: PHASE2-VERIFY vault passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fdd25489df40ac25baa68713ebc99b01aa7ad6a3a10bcd9530ef4d137d1338d7; exit=0; EXPECT=matched; output-sha256=3ff3e4d379f733e4e3c83ee1e58ee850d5237b92480c17f09b1e596566d95e27; output-bytes=85; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G6: the outbound privacy gate blocks raw PII, secrets, raw page structures, schema-invalid model payloads and private or non-https destinations without auto-fixing, allows sanitized payloads, and no runtime code reaches the network except through it
  CHECK: node scripts/verify/phase2.mjs gate
  EXPECT: PHASE2-VERIFY gate passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9124580135fdfdbca98e284cc3a7348a482ee46ec8f59877b4a6ef2fb94fa772; exit=0; EXPECT=matched; output-sha256=e0e970e9f798276d35789a3d402d7596d56351b1f7e2964ecc708dff10ebeaf2; output-bytes=106; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G7: the action firewall runs its ten checks in order and rejects forged, cross-task, cross-tab, stale, origin-changed, unrequested-navigation, unrequested-typing, injected-target, raw-password, payment, OTP and CAPTCHA actions, while allowing ordinary search actions
  CHECK: node scripts/verify/phase2.mjs firewall
  EXPECT: PHASE2-VERIFY firewall passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5fb9457a01579c8a9eb79859b003e036aea2b30d4523d30db7912a5cee954007; exit=0; EXPECT=matched; output-sha256=a33834aceea1ce71478b67c39aaed956a57833a5de851151f9d9a1522bcfbaed; output-bytes=88; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G8: in real Chromium, adversarial fixture pages cannot steer the agent (visible and hidden prompt injection, lure links, a payment result) and a page full of PII is detected locally while no raw value reaches storage, logs, history or the network
  CHECK: node scripts/verify/phase2.mjs adversarial
  EXPECT: PHASE2-VERIFY adversarial passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a15eab4ae88cac0362d75e7f8f166b60ff39051de94a49ef43a071891be6aab4; exit=0; EXPECT=matched; output-sha256=743d254f50aaef2de227e0c05ed820cf5798e0cf7f6a5feba39fa6c07ed34bcc; output-bytes=97; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G9: the audit log is persisted, hash-chained, verifiable, detects tampering and deletion, records policy and privacy decisions, and contains no raw sensitive values
  CHECK: node scripts/verify/phase2.mjs audit
  EXPECT: PHASE2-VERIFY audit passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9e7fbbeb34f8fac0a8006b8d680598f668acab70674da9ae01efcac7de1af405; exit=0; EXPECT=matched; output-sha256=6589fb92f31f9b65430f801146655c0e47a5086ba5e6a130033f5595f0a512b1; output-bytes=95; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G10: privacy scanning and the firewall keep fixture latency within 15% of the Phase 1 baseline, and their own per-stage cost is measured and recorded
  CHECK: node scripts/verify/phase2.mjs performance
  EXPECT: PHASE2-VERIFY performance passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6cdb0da608f638f603e3f420ce29157580f26e279e08571b37c44d5568d016e6; exit=0; EXPECT=matched; output-sha256=f0bec58f7f8e8747d91a35f8ae341a4c46b12095d424851197c6ca1937571eaa; output-bytes=140; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G11: documentation reflects Phase 2: a threat model giving asset, attacker, attack path, defense, residual risk and test for every listed threat, plus privacy, firewall, security, status and a 20-section report
  CHECK: node scripts/verify/phase2.mjs docs
  EXPECT: PHASE2-VERIFY docs passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=145b81a673e234c2b3b33e2551af93ff67c1b5bf9b962205e9d8cb021ceb8870; exit=0; EXPECT=matched; output-sha256=d8f0e29be77629b81d2a17777739267fb0b3a505da65d2791f3c56d0d77e6bbb; output-bytes=138; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries
