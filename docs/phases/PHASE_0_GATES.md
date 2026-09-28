# Gates: Phase 0 — Foundation

OWNS: package.json, package-lock.json, tsconfig*.json, eslint.config.js, vitest.config.ts, playwright.config.ts, .prettierrc.json, .prettierignore, .gitignore, .editorconfig, .nvmrc, .env.example, .github/**, packages/**, apps/**, tests/**, scripts/**, fixtures/**, docs/**, README.md, CLAUDE.md

Scope: a clean TypeScript monorepo whose contracts, config, logging and browser adapters compile and are tested, whose Chrome MV3 extension builds and actually loads in a real Chromium, whose Firefox target builds and lints, with CI and a truthful documentation skeleton.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/vikhyathmgowda007/Developer/eos-capabilities/unlazy/scripts/gate-lint.mjs docs/phases/PHASE_0_GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=52424bfa50f51b8259e42b481121877790bbc23acc505c9f55003faa900539c4; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G1: the whole workspace type-checks with zero errors under strict mode
  CHECK: node scripts/verify/phase0.mjs typecheck
  EXPECT: PHASE0-VERIFY typecheck passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c54ff9545041cb4c6de9a0fef6bb0c1a0252c39674d9080eee73fbd7fe7ca495; exit=0; EXPECT=matched; output-sha256=6829f99b231f51c6f95804d28ede637b40e89695f64f996ab875fa816c01d794; output-bytes=31; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G2: ESLint (including the no-eval security rules) and Prettier report zero problems
  CHECK: node scripts/verify/phase0.mjs lint
  EXPECT: PHASE0-VERIFY lint passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7246070bbcd555a265ee40eda494750d5ae3df1d974bd7f9763bd205c78c1ab0; exit=0; EXPECT=matched; output-sha256=34f471f1bac1f8a0287121f7733383ba90435cd0ea5ba4c0156ec9d59fdecfd6; output-bytes=26; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G3: the unit test runner executes every suite and all tests pass, including malformed-contract rejection tests
  CHECK: node scripts/verify/phase0.mjs unit
  EXPECT: PHASE0-VERIFY unit passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f820680e824deed4f2dcf5d6669b833124f152648b433adc1639e8f266056400; exit=0; EXPECT=matched; output-sha256=629b8fdb58905e8f3122976452777a91e7aec9291ad4f9d1691ee52152e6f831; output-bytes=58; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G4: the Chrome MV3 build emits a valid manifest whose service worker, side panel, options page, content script and icons all exist on disk
  CHECK: node scripts/verify/phase0.mjs chrome-build
  EXPECT: PHASE0-VERIFY chrome-build passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ced37839051d7ec39361046d5b40f66aecb719f52d09072b0e79e838906d3937; exit=0; EXPECT=matched; output-sha256=d8430eaa094abd805b622632d2b20c0a2620c6b1440c7cfdb902559356f37fbf; output-bytes=85; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G5: the Firefox build emits a gecko-targeted manifest (background scripts, sidebar_action) and passes Mozilla's web-ext lint with zero errors
  CHECK: node scripts/verify/phase0.mjs firefox-build
  EXPECT: PHASE0-VERIFY firefox-build passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=25169d931ce08f546ee2a690913c30b4ede7abf451ca3e2f3ba075f870f34ed3; exit=0; EXPECT=matched; output-sha256=1ec907dc5cfad1d2d22e684cd7248f363b6e8599ae7f732424c1f1a425121e56; output-bytes=84; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G6: the built Chrome extension loads in a real Chromium, its service worker answers a schema-validated health request, the content script answers from a live page, and the side panel and settings pages render and persist settings
  CHECK: node scripts/verify/phase0.mjs e2e
  EXPECT: PHASE0-VERIFY e2e passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2687fb4c6c37018bef334acd97453f66c6059ccbc7873733d7d5639774141475; exit=0; EXPECT=matched; output-sha256=a0f1379350695bef61b305e07742ac1b091a1317df64b060ea98c315b765c808; output-bytes=61; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G7: every documentation file required by master plan section 53 exists and declares an implementation status
  CHECK: node scripts/verify/phase0.mjs docs
  EXPECT: PHASE0-VERIFY docs passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=20335828309f4d377dbe26190a52b66f9f3b389c0cd983b7e9b50f77d872193f; exit=0; EXPECT=matched; output-sha256=e885e8185af73fc08bd455d5df04f6e0aced64865111183a573020136572f489; output-bytes=65; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries

- [x] G8: the repository contains no eval/new Function, no committed secrets, an .env.example, and a CI workflow that runs lint, typecheck, unit, build and browser tests
  CHECK: node scripts/verify/phase0.mjs hygiene
  EXPECT: PHASE0-VERIFY hygiene passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4baec1c8f6b49b09e3f87ee6c4b61a9e14b8bf6c88c01f5a125180175ac95e31; exit=0; EXPECT=matched; output-sha256=66ca8e8a7cc2a73ae5feac20061ce2c0ac26f0fdef88fa3e4dcd87696654e278; output-bytes=91; shell=/bin/sh; cwd=/Users/vikhyathmgowda007/Developer/new techy; path=d836ea1d37db/20 entries
