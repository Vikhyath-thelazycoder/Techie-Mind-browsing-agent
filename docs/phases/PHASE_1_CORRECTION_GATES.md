# Gates: Phase 1 Correction — Website Resolution, Current-Tab Awareness, Task Continuity

OWNS: packages/**, apps/**, tests/**, scripts/**, docs/**, playwright.config.ts, vitest.config.ts, package.json, package-lock.json, CLAUDE.md, README.md

Scope: the Phase 1 agent core decides WHERE to act before it navigates: an explicit current-tab request, an explicit URL/domain, a named website, the current page when it can satisfy the request, generic website resolution for arbitrary brand names, and search-engine discovery only as the last resort. A follow-up command continues in the existing tab. No brand, site or phrase is hard-coded in runtime source. No Phase 2+ capability (model routing, vision, skills, monitoring) is added.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/vikhyathmgowda007/Developer/eos-capabilities/unlazy/scripts/gate-lint.mjs docs/phases/PHASE_1_CORRECTION_GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=10a0418f7afe2b4c131cfa98550c7d5ecf74be093db81512b8bc83d8b68a471f; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G1: every Phase 0 acceptance gate still passes (regression)
  CHECK: node scripts/verify/phase0.mjs all
  EXPECT: PHASE0-VERIFY ALL 8 passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=624a4ab3e1c468a107c019486becf7628fabffa8983357863dd54ed529979b70; exit=0; EXPECT=matched; output-sha256=110353ea2955f416a9b44f196a67c3357f1dbb3b29bd9f2004f23366581ad8f8; output-bytes=535; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G2: every original Phase 1 acceptance gate still passes on the corrected code (static, unit, generic, fixtures, live A–C, live variations, performance, security, docs)
  CHECK: node scripts/verify/phase1.mjs all
  EXPECT: PHASE1-VERIFY ALL 9 passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b12b9df72310c1ea28a188b4deeb3815dcb69d19fb57cb482b4dad83676ed4ce; exit=0; EXPECT=matched; output-sha256=7ef135739ab7784d0455484a372045688252542fe2b93a6c90a9a97d92a52b5b; output-bytes=755; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G3: intent and navigation-policy unit suites prove targetSource/navigationPolicy for current-tab phrases, explicit domains, named sites, unknown brands, ordinal follow-ups and last-resort search, each with several wordings, and the acceptance brand names do not appear in runtime source
  CHECK: node scripts/verify/phase1.mjs policy
  EXPECT: PHASE1-VERIFY policy passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dae4c269768088cf51f5a02bd1b6785803371a90feddc02d8049bba6f84603f6; exit=0; EXPECT=matched; output-sha256=28f012e0120d45dedb4672c296557ceabf6863273528c3032b4eba4a28526809; output-bytes=98; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G4: website resolution scores real-shaped probe evidence correctly — identity match, redirect convergence, moved-notice endorsement, parked/for-sale and unrelated-redirect rejection, bot-wall plausibility, ambiguity detection — with no brand list
  CHECK: node scripts/verify/phase1.mjs resolution
  EXPECT: PHASE1-VERIFY resolution passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=674d34172af36bc345b33fdb4f7acb2aa3f763a9f1c6245bd2bee74e16ffe031; exit=0; EXPECT=matched; output-sha256=5625b2593625db3c2b73bb64ce4e3669d94e02fd1a5684996f86f2b9858460ff; output-bytes=101; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G5: in real Chromium on fixture sites the agent resolves an unknown brand to its site without a search engine, reuses the current tab for explicit and implicit context, continues a second command in the first command's tab, plays the Nth result of the current results page, hands over on an unresolvable or ambiguous brand, and navigates away only when the current page cannot satisfy the request
  CHECK: node scripts/verify/phase1.mjs context
  EXPECT: PHASE1-VERIFY context passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8f75ac74fbe775ed84398140c473ffcdee4c2ae0adaae445d104d0661783e406; exit=0; EXPECT=matched; output-sha256=d217c6c8ba55c39f6e1ae6a9851cba9362b148c01c3e9aa02918a24994b3ea87; output-bytes=75; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G6: correction acceptance tests A–I pass on live websites (Zara, Snitch, Myntra, Nike, YouTube current tab, YouTube reuse + play, Zara current tab, two-command continuity, results-context play) with independent verification that no search engine was visited when a site was resolvable
  CHECK: node scripts/verify/phase1.mjs correction-live
  EXPECT: PHASE1-VERIFY correction-live passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=95c48f9a63e57e3c16e598de6e688f2a02b82cb9fdc5715d8b3728e76f4ea598; exit=0; EXPECT=matched; output-sha256=917d8313bd08429e5843e46cce6a9a00d551d866e064fea041a8434c735f4db6; output-bytes=108; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G7: acceptance J — differently worded variants of A–I pass on live websites without code changes
  CHECK: node scripts/verify/phase1.mjs correction-variants
  EXPECT: PHASE1-VERIFY correction-variants passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=35522c26009b14906a90770c23615645fb431dbb14a0e3ff5f624a608e91c139; exit=0; EXPECT=matched; output-sha256=401855c3ca9cdb4bdbc4320b4822d87e1bf52bf119ebc5007c56dd4b953be1ec; output-bytes=105; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries

- [x] G8: the correction report documents website resolution, current-tab behaviour, continuity, navigation policy, new tests, regression, performance impact and limitations, and status docs reflect the correction
  CHECK: node scripts/verify/phase1.mjs correction-docs
  EXPECT: PHASE1-VERIFY correction-docs passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4d18179569ac7e9314e6c91e401095c8012e9987de13ed3b52dd050e096013f0; exit=0; EXPECT=matched; output-sha256=2455f4a97047fdf21ae68020ac9dea732b3f794f3422ec333a9ad90ce8cae882; output-bytes=104; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=12a03e0d599d/23 entries
