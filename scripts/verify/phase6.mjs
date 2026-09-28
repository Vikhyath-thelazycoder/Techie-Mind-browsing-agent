#!/usr/bin/env node
/**
 * Phase 6 acceptance verifier (docs/phases/PHASE_6_GATES.md).
 *
 *   node scripts/verify/phase6.mjs <regression|matrix|page|research|browser-apis|browser|docs|all>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assert,
  build,
  main,
  node,
  phaseGate,
  playwrightJson,
  requireAllPassed,
  requireSuite,
  requireTest,
  requireTitles,
  ROOT,
  vitestJson,
} from './lib.mjs';

const SKILL_TESTS = ['packages/agent-core/test/skills.test.ts'];
const IDS = [
  'summarize-page',
  'deep-research',
  'extract-data',
  'compare-prices',
  'fill-form',
  'find-alternatives',
  'manage-bookmarks',
  'monitor-page',
  'organize-tabs',
  'read-later',
  'save-page',
  'screenshot-walkthrough',
];

function regression() {
  const report = vitestJson();
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} unit tests failed`,
  );
  assert(report.numTotalTests >= 430, `only ${report.numTotalTests} unit tests`);
  for (const gate of ['extraction', 'commands', 'ecommerce', 'forms', 'output', 'media']) {
    phaseGate(node, 'scripts/verify/phase5.mjs', gate, 'PHASE5-VERIFY');
  }
  for (const gate of ['routing', 'privacy', 'authority'])
    phaseGate(node, 'scripts/verify/phase3.mjs', gate, 'PHASE3-VERIFY');
  for (const gate of ['lazy', 'privacy'])
    phaseGate(node, 'scripts/verify/phase4.mjs', gate, 'PHASE4-VERIFY');
  phaseGate(node, 'scripts/verify/phase2.mjs', 'gate', 'PHASE2-VERIFY');
  console.log(
    `regression: ${report.numPassedTests}/${report.numTotalTests} unit tests; Phase 2–5 gates hold`,
  );
}

/** Every skill: manifest + recognition (matrix test) + an executor branch + a named test. */
function matrix() {
  const report = vitestJson(SKILL_TESTS);
  requireSuite(report, 'skill matrix', 2);
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  const tests = [
    readFileSync(join(ROOT, 'packages/agent-core/test/skills.test.ts'), 'utf8'),
    readFileSync(join(ROOT, 'packages/agent-core/test/workflows.test.ts'), 'utf8'),
  ].join('\n');
  const rows = [];
  for (const id of IDS) {
    assert(runner.includes(`case '${id}':`), `no executor branch for ${id}`);
    const tested =
      tests.includes(`'${id}'`) ||
      tests.includes(`${id}:`) ||
      (id === 'summarize-page' && /summari[sz]e this page/.test(tests)) ||
      (id === 'fill-form' && /fill my delivery address/.test(tests));
    assert(tested, `no test exercises ${id}`);
    rows.push(id);
  }
  console.log(`matrix: ${rows.length}/12 skills — manifest, recognition, executor, tests`);
}

function page() {
  const report = vitestJson([...SKILL_TESTS, 'packages/agent-core/test/workflows.test.ts']);
  requireSuite(report, 'skills — page', 4);
  requireSuite(report, 'Phase 5 — summaries', 2);
  requireSuite(report, 'Phase 5 — forms from the encrypted profile', 2);
  console.log(
    'page: summarize, extract (items/table, CSV/JSON), walkthrough (redacted + marks), save page, fill form',
  );
}

function research() {
  const report = vitestJson(SKILL_TESTS);
  const s = requireSuite(report, 'skills — multi-source', 4);
  requireTest(report, 'a store without a matching item is reported, not estimated');
  console.log(
    `research: ${s.passed} tests — compare prices, alternatives, deep research with citations`,
  );
}

function browserApis() {
  const report = vitestJson(SKILL_TESTS);
  const s = requireSuite(report, 'skills — browser data', 4);
  const data = readFileSync(join(ROOT, 'apps/extension/src/background/browser-data.ts'), 'utf8');
  assert(
    /const cleanUrl = \(url: string\) => url\.split\(\/\[\?#\]\/\)\[0\]/.test(data),
    'stored URLs keep query strings',
  );
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  assert(
    /!t\.pinned && !t\.active/.test(runner),
    'duplicate closing may close pinned or active tabs',
  );
  console.log(
    `browser-apis: ${s.passed} tests — bookmarks, tabs, read later, monitors; pinned/active never closed`,
  );
}

function browser() {
  build();
  const skills = playwrightJson(['--project=browser', 'tests/browser/skills.spec.ts']);
  requireAllPassed(skills, 6, 'Phase 6 skills (real Chrome)');
  requireTitles(skills.results, [
    'bookmark this page',
    'organize my tabs',
    'read later',
    'compare hp laptop prices',
    'research laptops',
    'screenshot walkthrough',
  ]);
  const all = playwrightJson(['--project=browser']);
  const { results, tolerated } = requireAllPassed(all, 56, 'real-Chrome suite');
  console.log(
    `browser: ${skills.results.length} skill scenarios; ${results.length - tolerated}/${results.length} real-Chrome tests pass${tolerated ? ` (${tolerated} environment-only)` : ''}`,
  );
}

function docs() {
  const doc = readFileSync(join(ROOT, 'docs/SKILLS.md'), 'utf8');
  for (const id of IDS) assert(doc.includes(`\`${id}\``), `SKILLS.md does not document ${id}`);
  for (const w of ['Privacy', 'Security', 'Verification', 'Failure'])
    assert(doc.includes(w), `SKILLS.md lacks ${w}`);
  console.log(
    'docs: 12 skills documented with privacy, security, verification and failure handling',
  );
}

await main('PHASE6-VERIFY', {
  regression,
  matrix,
  page,
  research,
  'browser-apis': browserApis,
  browser,
  docs,
});
