#!/usr/bin/env node
/**
 * Phase 1 acceptance verifier (docs/phases/PHASE_1_GATES.md).
 * Each subcommand runs the real tool, inspects structured output, and prints
 * `PHASE1-VERIFY <name> passed` only after every assertion holds. Any failure exits non-zero.
 *
 *   node scripts/verify/phase1.mjs <static|unit|generic|fixtures|acceptance|variations|performance|security|docs|all>
 *   Phase 1 correction (docs/phases/PHASE_1_CORRECTION_GATES.md):
 *   node scripts/verify/phase1.mjs <policy|resolution|context|correction-live|correction-variants|correction-docs>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = join(ROOT, 'node_modules/.bin');
const EVIDENCE = join(ROOT, 'evidence');

class GateFailure extends Error {}
function assert(condition, message) {
  if (!condition) throw new GateFailure(message);
}

function run(cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(join(BIN, cmd), args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (!allowFail && result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-30);
    throw new GateFailure(
      `\`${cmd} ${args.join(' ')}\` exited ${result.status}\n${tail.join('\n')}`,
    );
  }
  return result;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'test-results'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function vitestJson(args = []) {
  const out = join(mkdtempSync(join(tmpdir(), 'tm-vitest-')), 'report.json');
  run('vitest', ['run', '--reporter=json', `--outputFile=${out}`, ...args]);
  return readJson(out);
}

function playwrightJson(args) {
  const result = run('playwright', ['test', '--reporter=json', ...args], { allowFail: true });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new GateFailure(
      `playwright produced no JSON report (exit ${result.status}):\n${result.stderr.slice(-2000)}`,
    );
  }
  const specs = report.suites.flatMap(function collect(s) {
    return [...(s.specs ?? []), ...(s.suites ?? []).flatMap(collect)];
  });
  const results = specs.map((s) => ({
    title: s.title,
    status: s.tests.flatMap((t) => t.results.map((r) => r.status)).at(-1) ?? 'missing',
    error: s.tests
      .flatMap((t) =>
        t.results.flatMap((r) => (r.error?.message ? [r.error.message.split('\n')[0]] : [])),
      )
      .join(' | '),
  }));
  return { exit: result.status, results, stats: report.stats };
}

function requireAllPassed({ exit, results, stats }, minimum, label) {
  const failed = results.filter((r) => r.status !== 'passed');
  assert(
    results.length >= minimum,
    `${label}: expected ≥${minimum} tests, found ${results.length}`,
  );
  assert(
    failed.length === 0,
    `${label} failures:\n${failed.map((f) => `  ✘ ${f.title}: ${f.error}`).join('\n')}`,
  );
  assert(
    exit === 0 && stats.unexpected === 0 && stats.skipped === 0,
    `${label}: unexpected or skipped tests`,
  );
  return results;
}

const build = () => run('tsx', ['apps/extension/scripts/build.ts', 'chrome']);

// ── gates ──────────────────────────────────────────────────────────────────

function staticChecks() {
  run('tsc', ['-p', 'tsconfig.json', '--noEmit']);
  run('eslint', ['.', '--max-warnings=0']);
  run('prettier', ['--check', '.']);
}

function unit() {
  const report = vitestJson();
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} unit tests failed`,
  );
  assert(report.numTotalTests >= 180, `expected ≥180 unit tests, found ${report.numTotalTests}`);
  const files = report.testResults.map((r) => relative(ROOT, r.name));
  for (const suite of [
    'packages/agent-core/test/intent.test.ts',
    'packages/agent-core/test/grounding.test.ts',
    'packages/agent-core/test/verify.test.ts',
    'packages/agent-core/test/runner.test.ts',
    'packages/perception/test/perception.test.ts',
    'packages/perception/test/executor.test.ts',
    'apps/extension/test/content.test.ts',
    'apps/extension/test/host-and-tasks.test.ts',
  ]) {
    assert(files.includes(suite), `required suite did not run: ${suite}`);
  }
  console.log(
    `unit: ${report.numPassedTests}/${report.numTotalTests} passed in ${files.length} files`,
  );
}

/** Acceptance phrases/queries that must never appear in runtime source. */
const FORBIDDEN = /kannada\s+songs|python\s+tutorials?|running\s+shoes/i;

function generic() {
  const runtime = [
    ...walk(join(ROOT, 'packages')).filter((f) => f.includes('/src/')),
    ...walk(join(ROOT, 'apps/extension/src')),
  ].filter((f) => /\.(ts|tsx)$/.test(f));
  const hits = runtime.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
  assert(
    hits.length === 0,
    `acceptance phrases hard-coded in runtime source: ${hits.map((f) => relative(ROOT, f)).join(', ')}`,
  );
  // Positive control: the same scanner finds the phrases where they legitimately live (tests).
  const control = join(ROOT, 'tests/live/acceptance.spec.ts');
  assert(FORBIDDEN.test(readFileSync(control, 'utf8')), 'scanner positive control failed');

  const report = vitestJson(['packages/agent-core/test/intent.test.ts']);
  const phrasings = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.ancestorTitles.includes('resolveIntent — generic clause-based resolution'));
  const passed = phrasings.filter((a) => a.status === 'passed').length;
  assert(
    passed === phrasings.length && passed > 10,
    `intent phrasings: ${passed}/${phrasings.length} passed`,
  );
  console.log(
    `generic: ${runtime.length} runtime files clean; ${passed} phrasings resolve correctly`,
  );
}

const FIXTURE_TESTS = [
  'classic form search',
  'different wording and query',
  'script-driven search with no form',
  'collapsed search is revealed',
  're-mounted under the agent is re-grounded',
  'falls back to the search button',
  'play request',
  'page without search',
  'side panel UI',
];

function fixtures() {
  build();
  const results = requireAllPassed(
    playwrightJson(['--project=browser', 'tests/browser/agent.spec.ts']),
    9,
    'fixture agent tests',
  );
  for (const needle of FIXTURE_TESTS) {
    assert(
      results.some((r) => r.title.includes(needle) && r.status === 'passed'),
      `missing passing fixture scenario: ${needle}`,
    );
  }
  console.log(`fixtures: ${results.length}/${results.length} real-Chromium agent scenarios passed`);
}

function liveEvidence() {
  const path = join(EVIDENCE, 'phase1-live.json');
  assert(existsSync(path), 'live evidence file missing');
  return readJson(path);
}

function acceptance() {
  build();
  const results = requireAllPassed(
    playwrightJson(['--project=live', '-g', 'Phase 1 acceptance']),
    3,
    'live acceptance',
  );
  for (const id of ['Test A', 'Test B', 'Test C']) {
    assert(
      results.some((r) => r.title.startsWith(id) && r.status === 'passed'),
      `${id} did not pass`,
    );
  }
  const evidence = liveEvidence();
  for (const [id, host, query] of [
    ['A', 'www.youtube.com', 'kannada songs'],
    ['B', 'www.youtube.com', 'python tutorials'],
    ['C', 'www.flipkart.com', 'running shoes'],
  ]) {
    const e = evidence.find((x) => x.name === id);
    assert(e && e.status === 'COMPLETED', `no COMPLETED evidence for test ${id}`);
    assert(e.independent.host === host, `test ${id} host ${e.independent.host}`);
    assert(
      e.independent.param?.toLowerCase() === query && e.independent.field?.toLowerCase() === query,
      `test ${id} query mismatch`,
    );
    assert(
      e.independent.matchingLinks >= 3,
      `test ${id}: only ${e.independent.matchingLinks} visible matching results`,
    );
  }
  console.log('acceptance: A, B, C passed on live sites with independent verification');
}

function variations() {
  build();
  const results = requireAllPassed(
    playwrightJson(['--project=live', '-g', 'Phase 1 variations']),
    3,
    'live variations',
  );
  console.log(`variations: ${results.length}/${results.length} live variations passed`);
}

const STAGES = [
  'intentMs',
  'navigationMs',
  'observationMs',
  'groundingMs',
  'actionMs',
  'verificationMs',
  'waitMs',
  'totalMs',
];

function performance() {
  build();
  requireAllPassed(
    playwrightJson(['--project=browser', 'tests/browser/agent-performance.spec.ts']),
    1,
    'latency run',
  );
  const perf = readJson(join(EVIDENCE, 'perf-phase1-fixtures.json'));
  assert(
    perf.tasks >= 20 && perf.modelCalls === 0,
    `perf: ${perf.tasks} tasks, ${perf.modelCalls} model calls`,
  );
  for (const stage of STAGES) {
    const s = perf.stages[stage];
    assert(
      s && Number.isFinite(s.p50) && Number.isFinite(s.p95),
      `perf: stage ${stage} not measured`,
    );
  }
  const live = liveEvidence().filter((e) => ['A', 'B', 'C'].includes(e.name));
  assert(
    live.length === 3 && live.every((e) => STAGES.every((k) => Number.isFinite(e.timings[k]))),
    'live stage timings missing',
  );
  console.log(
    `performance: fixture total P50 ${perf.stages.totalMs.p50.toFixed(0)} ms / P95 ${perf.stages.totalMs.p95.toFixed(0)} ms`,
  );
}

function security() {
  build();
  requireAllPassed(
    playwrightJson(['--project=browser', 'tests/browser/security.spec.ts']),
    2,
    'browser security',
  );
  const report = vitestJson([
    'packages/perception/test/executor.test.ts',
    'apps/extension/test/content.test.ts',
    'apps/extension/test/host-and-tasks.test.ts',
    'packages/contracts/test/action.test.ts',
  ]);
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} security unit tests failed`,
  );
  console.log(`security: 2 real-browser suites + ${report.numPassedTests} unit checks passed`);
}

function docs() {
  const read = (p) => readFileSync(join(ROOT, 'docs', p), 'utf8');
  assert(
    /\|\s*1\s*\|\s*Real Browser Agent Core\s*\|\s*\*\*Complete\*\*/.test(
      read('IMPLEMENTATION_STATUS.md'),
    ),
    'IMPLEMENTATION_STATUS does not record Phase 1',
  );
  for (const doc of [
    'PERCEPTION.md',
    'ARCHITECTURE.md',
    'PERFORMANCE.md',
    'KNOWN_LIMITATIONS.md',
    'TESTING.md',
    'TECHNICAL_DESIGN.md',
  ]) {
    assert(/Phase 1/.test(read(doc)), `docs/${doc} not updated for Phase 1`);
  }
  const report = read('phases/PHASE_1_REPORT.md');
  for (let i = 1; i <= 20; i++)
    assert(new RegExp(`^## ${i}\\. `, 'm').test(report), `report section ${i} missing`);
  for (const t of ['Test A', 'Test B', 'Test C'])
    assert(report.includes(t), `report does not state ${t}`);
  console.log(
    'docs: status, architecture, perception, performance, limitations and 20-section report present',
  );
}

// ── Phase 1 correction gates ───────────────────────────────────────────────

/** Correction acceptance names/phrases that must never appear in runtime source. */
const CORRECTION_FORBIDDEN = /zara|snitch|myntra|nike|reddit|hindi\s+songs|black\s+shirts/i;

function runtimeFiles() {
  return [
    ...walk(join(ROOT, 'packages')).filter((f) => f.includes('/src/')),
    ...walk(join(ROOT, 'apps/extension/src')),
  ].filter((f) => /\.(ts|tsx)$/.test(f));
}

function passedIn(report, describe) {
  const tests = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.ancestorTitles.some((t) => t.startsWith(describe)));
  return { total: tests.length, passed: tests.filter((a) => a.status === 'passed').length };
}

function policy() {
  const files = runtimeFiles();
  const hits = files.filter((f) => CORRECTION_FORBIDDEN.test(readFileSync(f, 'utf8')));
  assert(
    hits.length === 0,
    `correction brands/phrases hard-coded in runtime source: ${hits.map((f) => relative(ROOT, f)).join(', ')}`,
  );
  const control = join(ROOT, 'tests/live/correction.spec.ts');
  assert(
    CORRECTION_FORBIDDEN.test(readFileSync(control, 'utf8')),
    'scanner positive control failed',
  );

  const report = vitestJson([
    'packages/agent-core/test/navigation.test.ts',
    'packages/agent-core/test/intent.test.ts',
  ]);
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} policy tests failed`,
  );
  const wording = passedIn(report, 'intent: context-aware fields');
  const rules = passedIn(report, 'decideNavigation — priority order');
  assert(
    wording.total >= 30 && wording.passed === wording.total,
    `context-aware phrasings: ${wording.passed}/${wording.total}`,
  );
  assert(
    rules.total >= 10 && rules.passed === rules.total,
    `policy rules: ${rules.passed}/${rules.total}`,
  );
  console.log(
    `policy: ${files.length} runtime files clean; ${wording.passed} phrasings + ${rules.passed} priority rules pass`,
  );
}

function resolution() {
  const report = vitestJson([
    'packages/agent-core/test/website.test.ts',
    'packages/agent-core/test/runner.test.ts',
    'packages/agent-core/test/verify.test.ts',
    'apps/extension/test/host-and-tasks.test.ts',
  ]);
  assert(report.success && report.numFailedTests === 0, `${report.numFailedTests} tests failed`);
  const scoring = passedIn(report, 'resolveWebsite — evidence scoring');
  const runner = passedIn(report, 'runTask — current context, continuity and website resolution');
  const probe = passedIn(report, 'probeWebsite — resolution fetch boundaries');
  const challenge = passedIn(report, 'isChallengePage');
  assert(
    scoring.total >= 9 && scoring.passed === scoring.total,
    `scoring ${scoring.passed}/${scoring.total}`,
  );
  assert(
    runner.total >= 14 && runner.passed === runner.total,
    `runner ${runner.passed}/${runner.total}`,
  );
  assert(probe.total >= 2 && probe.passed === probe.total, `probe ${probe.passed}/${probe.total}`);
  assert(challenge.total >= 2 && challenge.passed === challenge.total, 'challenge detection');
  const titles = report.testResults.flatMap((r) => r.assertionResults.map((a) => a.title));
  for (const needle of [
    'converge',
    'moved',
    'parked',
    'bot-walled',
    'unrelated',
    'ambiguity',
    'in the real tab',
    'persistent CAPTCHA',
  ]) {
    assert(
      titles.some((t) => t.includes(needle)),
      `missing resolution scenario: ${needle}`,
    );
  }
  console.log(
    `resolution: ${scoring.passed} scoring + ${runner.passed} runner + ${probe.passed} probe + ${challenge.passed} challenge tests pass`,
  );
}

const CONTEXT_TESTS = [
  'positive control',
  'resolves the website and navigates there directly',
  'resolve, open and search in one request',
  'asks the user, navigates nowhere',
  'LAST resort',
  'explicit "in the current tab"',
  'continues on the open site',
  'open media site stays on that site',
  "continues in the first command's tab",
  'play the second result',
  'cannot satisfy the request',
  'no web page open fails honestly',
];

function context() {
  build();
  const results = requireAllPassed(
    playwrightJson(['--project=browser', 'tests/browser/context.spec.ts']),
    CONTEXT_TESTS.length,
    'context/resolution browser tests',
  );
  for (const needle of CONTEXT_TESTS) {
    assert(
      results.some((r) => r.title.includes(needle) && r.status === 'passed'),
      `missing passing scenario: ${needle}`,
    );
  }
  console.log(`context: ${results.length}/${results.length} real-Chromium scenarios passed`);
}

function correctionEvidence() {
  const path = join(EVIDENCE, 'phase1-correction-live.json');
  assert(existsSync(path), 'correction live evidence missing');
  return readJson(path);
}

function correctionLive() {
  build();
  const results = requireAllPassed(
    playwrightJson([
      '--project=live',
      'tests/live/correction.spec.ts',
      '-g',
      'Correction (website|context|continuity)',
    ]),
    9,
    'live correction A–I',
  );
  const evidence = correctionEvidence();
  const byId = (id) => evidence.find((e) => e.name === id);
  for (const id of ['A', 'B', 'C', 'D']) {
    const e = byId(id);
    assert(e && e.status === 'COMPLETED', `no COMPLETED evidence for ${id}`);
    assert(e.independent.searchEngineLoads === 0, `${id}: a search engine was loaded`);
    assert(
      e.independent.targetSource === 'RESOLVED_WEBSITE' && e.independent.resolvedTo,
      `${id}: not resolved`,
    );
  }
  for (const id of ['E', 'F', 'G', 'H', 'I']) {
    const e = byId(id);
    assert(e && e.status === 'COMPLETED', `no COMPLETED evidence for ${id}`);
    assert(e.independent.navigationsStarted === 0, `${id}: navigated instead of reusing the tab`);
    assert(e.independent.searchEngineLoads === 0, `${id}: a search engine was loaded`);
  }
  for (const id of ['F', 'I']) assert(byId(id).independent.playing === true, `${id}: not playing`);
  for (const id of ['H', 'I'])
    assert(byId(id).independent.sameTab === true, `${id}: different tab`);
  console.log(
    `correction-live: ${results.length} live tests (A–I) passed with independent evidence`,
  );
}

function correctionVariants() {
  build();
  const results = requireAllPassed(
    playwrightJson(['--project=live', 'tests/live/correction.spec.ts', '-g', 'Correction J']),
    8,
    'live correction J',
  );
  const evidence = correctionEvidence().filter((e) => e.name.startsWith('J-'));
  assert(evidence.length >= 8, `only ${evidence.length} J evidence entries`);
  for (const e of evidence) {
    assert(e.status === 'COMPLETED', `${e.name} not COMPLETED`);
    assert(e.independent.searchEngineLoads === 0, `${e.name}: a search engine was loaded`);
  }
  console.log(`correction-variants: ${results.length} differently worded live variants passed`);
}

function correctionDocs() {
  const read = (p) => readFileSync(join(ROOT, 'docs', p), 'utf8');
  const report = read('phases/PHASE_1_CORRECTION_REPORT.md');
  for (const heading of [
    'Website resolution behavior',
    'Current-tab behavior',
    'Task continuity',
    'Navigation policy',
    'New tests',
    'Existing regression tests',
    'Performance impact',
    'Known limitations',
  ]) {
    assert(new RegExp(`^## .*${heading}`, 'mi').test(report), `report section missing: ${heading}`);
  }
  for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    assert(
      new RegExp(`\\|\\s*\\**${t}\\**\\s*\\|`).test(report),
      `report does not state test ${t}`,
    );
  assert(
    /Phase 1 correction/i.test(read('IMPLEMENTATION_STATUS.md')),
    'status does not record the correction',
  );
  for (const doc of [
    'TECHNICAL_DESIGN.md',
    'KNOWN_LIMITATIONS.md',
    'TESTING.md',
    'PERFORMANCE.md',
    'ARCHITECTURE.md',
    'SECURITY.md',
  ]) {
    assert(/correction/i.test(read(doc)), `docs/${doc} not updated for the correction`);
  }
  console.log('correction-docs: report (8 topics, tests A–J) and 7 docs updated');
}

const ORIGINAL_GATES = [
  'static',
  'unit',
  'generic',
  'fixtures',
  'acceptance',
  'variations',
  'performance',
  'security',
  'docs',
];

const GATES = {
  static: staticChecks,
  unit,
  generic,
  fixtures,
  acceptance,
  variations,
  performance,
  security,
  docs,
  policy,
  resolution,
  context,
  'correction-live': correctionLive,
  'correction-variants': correctionVariants,
  'correction-docs': correctionDocs,
};

const requested = process.argv[2];
const names = requested === 'all' ? ORIGINAL_GATES : [requested];
let failed = false;
for (const name of names) {
  const gate = GATES[name];
  if (!gate) {
    console.error(`unknown gate "${name}". Use one of: ${Object.keys(GATES).join(', ')}, all`);
    process.exit(2);
  }
  try {
    gate();
    console.log(`PHASE1-VERIFY ${name} passed`);
  } catch (error) {
    failed = true;
    console.error(
      `PHASE1-VERIFY ${name} FAILED: ${error instanceof GateFailure ? error.message : error}`,
    );
  }
}
if (requested === 'all' && !failed) console.log(`PHASE1-VERIFY ALL ${names.length} passed`);
process.exit(failed ? 1 : 0);
