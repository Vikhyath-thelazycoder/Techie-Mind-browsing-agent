#!/usr/bin/env node
/**
 * Phase 2 acceptance verifier (docs/phases/PHASE_2_GATES.md).
 * Each subcommand runs the real tool, inspects structured output, and prints
 * `PHASE2-VERIFY <name> passed` only after every assertion holds. Any failure exits non-zero.
 *
 *   node scripts/verify/phase2.mjs <correction-regression|detection|vault|gate|firewall|adversarial|audit|performance|docs|all>
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

function run(cmd, args, { allowFail = false, bin = true } = {}) {
  const result = spawnSync(bin ? join(BIN, cmd) : cmd, args, {
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

function runtimeFiles() {
  return [
    ...walk(join(ROOT, 'packages')).filter((f) => f.includes('/src/')),
    ...walk(join(ROOT, 'apps/extension/src')),
  ].filter((f) => /\.(ts|tsx)$/.test(f));
}

function vitestJson(args = []) {
  const out = join(mkdtempSync(join(tmpdir(), 'tm-vitest-')), 'report.json');
  run('vitest', ['run', '--reporter=json', `--outputFile=${out}`, ...args]);
  return readJson(out);
}

/** Tests under a describe block: total and passed. */
function suite(report, describe) {
  const tests = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.ancestorTitles.some((t) => t.startsWith(describe)));
  return { total: tests.length, passed: tests.filter((a) => a.status === 'passed').length };
}

function requireSuite(report, describe, minimum) {
  const s = suite(report, describe);
  assert(s.total >= minimum, `"${describe}": expected ≥${minimum} tests, found ${s.total}`);
  assert(s.passed === s.total, `"${describe}": ${s.passed}/${s.total} passed`);
  return s;
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

function requireTitles(results, needles) {
  for (const needle of needles) {
    assert(
      results.some((r) => r.title.includes(needle) && r.status === 'passed'),
      `missing passing scenario: ${needle}`,
    );
  }
}

const build = () => run('tsx', ['apps/extension/scripts/build.ts', 'chrome']);

// ── gates ──────────────────────────────────────────────────────────────────

function correctionRegression() {
  for (const gate of ['policy', 'resolution', 'context']) {
    const r = run('node', ['scripts/verify/phase1.mjs', gate], { bin: false, allowFail: true });
    assert(
      r.status === 0 && r.stdout.includes(`PHASE1-VERIFY ${gate} passed`),
      `phase1 ${gate} failed:\n${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-10).join('\n')}`,
    );
  }
  console.log(
    'correction-regression: policy, resolution and context gates pass with the firewall in the loop',
  );
}

function detection() {
  const report = vitestJson(['packages/privacy/test/privacy.test.ts']);
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} privacy tests failed`,
  );
  requireSuite(report, 'checksums', 1);
  requireSuite(report, 'detection — the spec §80 privacy test page', 1);
  const kinds = requireSuite(report, 'detection — Indian identity, financial and secret kinds', 15);
  requireSuite(report, 'detection — layer 1 DOM semantics', 1);
  requireSuite(report, 'detection — labelled synthetic corpus', 1);
  const titles = report.testResults.flatMap((r) => r.assertionResults.map((a) => a.title));
  assert(
    titles.some((t) => t.includes('look-alikes')),
    'negative-control test missing',
  );
  const m = readJson(join(EVIDENCE, 'privacy-metrics.json'));
  assert(m.samples >= 300 && m.negatives >= 100, `corpus too small (${m.samples}/${m.negatives})`);
  assert(m.overall.precision >= 0.95, `precision ${m.overall.precision}`);
  assert(m.overall.recall >= 0.95, `recall ${m.overall.recall}`);
  assert(m.falseRedactionRate <= 0.05, `false redaction rate ${m.falseRedactionRate}`);
  for (const kind of ['name', 'email', 'phone', 'aadhaar', 'pan', 'password', 'card_number']) {
    assert(m.perKind[kind]?.tp > 0, `corpus has no detected ${kind}`);
  }
  console.log(
    `detection: ${kinds.passed} kind tests; corpus ${m.samples} samples · P ${m.overall.precision.toFixed(3)} R ${m.overall.recall.toFixed(3)} · false redaction ${m.falseRedactionRate.toFixed(3)}`,
  );
}

function vault() {
  const report = vitestJson(['packages/privacy/test/privacy.test.ts', '-t', 'token vault']);
  const s = requireSuite(report, 'token vault', 4);
  const source = readFileSync(join(ROOT, 'packages/privacy/src/vault.ts'), 'utf8');
  assert(
    !/localStorage|indexedDB|chrome\.storage|storageSet|sessionStorage|console\./.test(source),
    'vault touches storage or logs',
  );
  // No runtime module persists vault contents.
  const offenders = runtimeFiles().filter((f) =>
    /storageSet\([^)]*vault/i.test(readFileSync(f, 'utf8')),
  );
  assert(
    offenders.length === 0,
    `vault persisted in: ${offenders.map((f) => relative(ROOT, f)).join(', ')}`,
  );
  console.log(`vault: ${s.passed} lifecycle tests pass; memory-only (static check)`);
}

const NETWORK_API = /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|new\s+EventSource/;

function gate() {
  const report = vitestJson([
    'packages/privacy/test/privacy.test.ts',
    'apps/extension/test/host-and-tasks.test.ts',
  ]);
  const g = requireSuite(report, 'outbound privacy gate', 4);
  requireSuite(report, 'sanitizeObservation', 2);
  requireSuite(report, 'probeWebsite — resolution fetch boundaries', 2);
  // Wire guard: the only network call in runtime code is inside the gate.
  const callers = runtimeFiles().filter((f) => {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return NETWORK_API.test(code);
  });
  const rel = callers.map((f) => relative(ROOT, f));
  assert(
    rel.length === 1 && rel[0] === 'packages/privacy/src/gate.ts',
    `network access outside the privacy gate: ${rel.join(', ')}`,
  );
  // Positive control: the scanner does see network calls where they exist in tests.
  assert(
    NETWORK_API.test(readFileSync(join(ROOT, 'tests/browser/context.spec.ts'), 'utf8')),
    'wire-guard positive control failed',
  );
  console.log(
    `gate: ${g.passed} gate tests pass; ${runtimeFiles().length} runtime files — only the gate reaches the network`,
  );
}

function firewall() {
  const report = vitestJson([
    'packages/security/test/firewall.test.ts',
    'packages/agent-core/test/runner.test.ts',
  ]);
  const order = requireSuite(report, 'action firewall — order and happy path', 3);
  const binding = requireSuite(report, 'action firewall — binding, target, origin, freshness', 13);
  const policy = requireSuite(
    report,
    'action firewall — risk, privacy, injection, authorization',
    6,
  );
  requireSuite(report, 'risk classification', 1);
  const loop = requireSuite(report, 'runTask — security and privacy in the loop', 4);
  const titles = report.testResults.flatMap((r) => r.assertionResults.map((a) => a.title));
  for (const needle of [
    'another task',
    'another tab',
    'swapped identity',
    'stale document',
    'changed origin',
    'did not ask for',
    'did not provide',
    'provenance',
    'instructions aimed at the agent',
    'password field',
    'payment, OTP, CAPTCHA',
    'allows the ordinary search actions',
  ]) {
    assert(
      titles.some((t) => t.includes(needle)),
      `missing firewall scenario: ${needle}`,
    );
  }
  console.log(
    `firewall: ${order.passed + binding.passed + policy.passed} firewall tests + ${loop.passed} in-loop runner tests pass`,
  );
}

function adversarial() {
  build();
  const results = requireAllPassed(
    playwrightJson([
      '--project=browser',
      'tests/browser/adversarial.spec.ts',
      'tests/browser/security.spec.ts',
    ]),
    7,
    'adversarial browser tests',
  );
  requireTitles(results, [
    'ignores banner, hidden and lure-link instructions',
    'payment result is handed over, never clicked',
    'no raw value reaches events, storage, history, audit or network',
    'positive control',
    'content script rejects',
  ]);
  console.log(
    `adversarial: ${results.length}/${results.length} real-Chromium adversarial/privacy tests passed`,
  );
}

function audit() {
  const report = vitestJson(['packages/telemetry/test/telemetry.test.ts']);
  const persisted = requireSuite(report, 'PersistentAuditLog', 3);
  requireSuite(report, 'audit hashing is independent of storage key order', 1);
  build();
  const results = requireAllPassed(
    playwrightJson([
      '--project=browser',
      'tests/browser/adversarial.spec.ts',
      '-g',
      'audit log|no raw value',
    ]),
    2,
    'audit browser tests',
  );
  requireTitles(results, ['audit log survives across tasks and detects tampering']);
  console.log(
    `audit: ${persisted.passed} persistence/tamper unit tests + ${results.length} real-browser checks pass`,
  );
}

function performance() {
  build();
  requireAllPassed(
    playwrightJson(['--project=browser', 'tests/browser/agent-performance.spec.ts']),
    1,
    'latency run',
  );
  const perf = readJson(join(EVIDENCE, 'perf-phase1-fixtures.json'));
  const base = readJson(join(EVIDENCE, 'perf-phase1-baseline.json'));
  assert(
    perf.tasks >= 20 && perf.modelCalls === 0,
    `perf: ${perf.tasks} tasks, ${perf.modelCalls} model calls`,
  );
  for (const stage of ['privacyMs', 'firewallMs']) {
    assert(Number.isFinite(perf.stages[stage]?.p50), `stage ${stage} not measured`);
  }
  const p50 = perf.stages.totalMs.p50;
  const p95 = perf.stages.totalMs.p95;
  assert(
    p50 <= base.totalMs.p50 * 1.15,
    `P50 ${p50.toFixed(0)} ms > 115% of ${base.totalMs.p50} ms`,
  );
  assert(
    p95 <= base.totalMs.p95 * 1.15,
    `P95 ${p95.toFixed(0)} ms > 115% of ${base.totalMs.p95} ms`,
  );
  console.log(
    `performance: total P50 ${p50.toFixed(0)} ms (baseline ${base.totalMs.p50}) · P95 ${p95.toFixed(0)} ms · privacy P50 ${perf.stages.privacyMs.p50.toFixed(1)} ms · firewall P50 ${perf.stages.firewallMs.p50.toFixed(1)} ms`,
  );
}

const THREATS = [
  'malicious website',
  'prompt injection',
  'malicious model output',
  'stale dom',
  'cross-tab',
  'origin confusion',
  'tab confusion',
  'dom mutation',
  'ssrf',
  'dns rebinding',
  'monitor idor',
  'credential leakage',
  'email injection',
  'service-worker restart',
  'model-provider leakage',
  'human approval confusion',
];

function docs() {
  const read = (p) => readFileSync(join(ROOT, 'docs', p), 'utf8');
  const threat = read('THREAT_MODEL.md');
  for (const column of ['Asset', 'Attacker', 'Attack path', 'Defense', 'Residual risk', 'Test']) {
    assert(threat.includes(column), `threat model lacks column "${column}"`);
  }
  const lower = threat.toLowerCase();
  for (const t of THREATS) assert(lower.includes(t), `threat model lacks "${t}"`);
  for (const doc of ['PRIVACY.md', 'ACTION_FIREWALL.md', 'SECURITY.md']) {
    assert(
      /Phase 2/.test(read(doc)) && !/Not started/.test(read(doc)),
      `docs/${doc} not updated for Phase 2`,
    );
  }
  assert(
    /\|\s*2\s*\|\s*Security \+ Privacy\s*\|\s*\*\*Complete\*\*/.test(
      read('IMPLEMENTATION_STATUS.md'),
    ),
    'IMPLEMENTATION_STATUS does not record Phase 2',
  );
  const report = read('phases/PHASE_2_REPORT.md');
  for (let i = 1; i <= 20; i++)
    assert(new RegExp(`^## ${i}\\. `, 'm').test(report), `report section ${i} missing`);
  assert(existsSync(join(EVIDENCE, 'privacy-metrics.json')), 'privacy metrics evidence missing');
  console.log(
    'docs: threat model (16 threats × 6 columns), privacy, firewall, security, status and 20-section report present',
  );
}

const GATES = {
  'correction-regression': correctionRegression,
  detection,
  vault,
  gate,
  firewall,
  adversarial,
  audit,
  performance,
  docs,
};

const requested = process.argv[2];
const names = requested === 'all' ? Object.keys(GATES) : [requested];
let failed = false;
for (const name of names) {
  const fn = GATES[name];
  if (!fn) {
    console.error(`unknown gate "${name}". Use one of: ${Object.keys(GATES).join(', ')}, all`);
    process.exit(2);
  }
  try {
    fn();
    console.log(`PHASE2-VERIFY ${name} passed`);
  } catch (error) {
    failed = true;
    console.error(
      `PHASE2-VERIFY ${name} FAILED: ${error instanceof GateFailure ? error.message : error}`,
    );
  }
}
if (requested === 'all' && !failed) console.log(`PHASE2-VERIFY ALL ${names.length} passed`);
process.exit(failed ? 1 : 0);
