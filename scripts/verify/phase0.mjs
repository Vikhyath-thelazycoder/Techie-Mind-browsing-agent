#!/usr/bin/env node
/**
 * Phase 0 acceptance verifier (docs/phases/PHASE_0_GATES.md).
 * Each subcommand runs the real tool, inspects its structured output, and prints
 * `PHASE0-VERIFY <name> passed` only after every assertion holds. Any failure exits non-zero.
 *
 *   node scripts/verify/phase0.mjs <typecheck|lint|unit|chrome-build|firefox-build|e2e|docs|hygiene|all>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'apps/extension/dist');
const BIN = join(ROOT, 'node_modules/.bin');

/**
 * Content script: since Phase 1 it is injected on demand into the agent's tab only and never
 * declared for ordinary pages (zero per-page footprint). Its size is still bounded.
 */
const CONTENT_SCRIPT = 'content.js';
const CONTENT_SCRIPT_BUDGET_BYTES = 256 * 1024;

class GateFailure extends Error {}

function assert(condition, message) {
  if (!condition) throw new GateFailure(message);
}

function run(cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(join(BIN, cmd), args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  if (!allowFail && result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-25);
    throw new GateFailure(
      `\`${cmd} ${args.join(' ')}\` exited ${result.status}\n${tail.join('\n')}`,
    );
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, skip) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (skip.has(name)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full, skip));
    else out.push(full);
  }
  return out;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'playwright-report',
  'coverage',
  'reference',
]);

function sourceFiles() {
  return walk(ROOT, SKIP_DIRS).filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f));
}

// ── gates ──────────────────────────────────────────────────────────────────

function typecheck() {
  run('tsc', ['-p', 'tsconfig.json', '--noEmit']);
}

function lint() {
  run('eslint', ['.', '--max-warnings=0']);
  run('prettier', ['--check', '.']);
}

function unit() {
  const out = join(mkdtempSync(join(tmpdir(), 'tm-vitest-')), 'report.json');
  run('vitest', ['run', '--reporter=json', `--outputFile=${out}`]);
  const report = readJson(out);
  assert(report.success === true, 'vitest reported failure');
  assert(report.numFailedTests === 0, `${report.numFailedTests} unit tests failed`);
  assert(report.numTotalTests >= 100, `expected ≥100 unit tests, found ${report.numTotalTests}`);
  const files = report.testResults.map((r) => relative(ROOT, r.name));
  for (const required of [
    'packages/contracts/test/action.test.ts',
    'packages/contracts/test/contracts.test.ts',
    'packages/config/test/settings.test.ts',
    'packages/telemetry/test/telemetry.test.ts',
    'packages/browser/test/adapter.test.ts',
    'apps/extension/test/handlers.test.ts',
    'apps/extension/test/manifest.test.ts',
  ]) {
    assert(files.includes(required), `required suite did not run: ${required}`);
  }
  const rejectionTests = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => /reject/i.test(a.title) && a.status === 'passed');
  assert(
    rejectionTests.length >= 15,
    `expected ≥15 passing rejection tests, found ${rejectionTests.length}`,
  );
  console.log(
    `unit: ${report.numPassedTests}/${report.numTotalTests} passed in ${files.length} files`,
  );
}

function checkCommonManifest(dir, manifest) {
  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert(!/unsafe-eval|unsafe-inline/.test(csp), `CSP allows unsafe code: ${csp}`);
  for (const f of Object.values(manifest.icons ?? {})) {
    assert(existsSync(join(dir, f)), `missing file referenced by manifest: ${f}`);
  }
  assert(
    !('content_scripts' in manifest),
    'content scripts must not be declared for ordinary pages',
  );
  const content = join(dir, CONTENT_SCRIPT);
  assert(existsSync(content), `missing on-demand content script ${CONTENT_SCRIPT}`);
  const size = statSync(content).size;
  assert(
    size <= CONTENT_SCRIPT_BUDGET_BYTES,
    `content script ${size} B exceeds ${CONTENT_SCRIPT_BUDGET_BYTES} B budget`,
  );
  return size;
}

function chromeBuild() {
  run('tsx', ['apps/extension/scripts/build.ts', 'chrome']);
  const dir = join(DIST, 'chrome');
  const m = readJson(join(dir, 'manifest.json'));
  const size = checkCommonManifest(dir, m);
  assert(
    m.background?.service_worker && m.background.type === 'module',
    'Chrome needs a module service worker',
  );
  for (const f of [m.background.service_worker, m.side_panel?.default_path, m.options_page]) {
    assert(typeof f === 'string' && existsSync(join(dir, f)), `missing Chrome entry: ${f}`);
  }
  assert(m.permissions.includes('sidePanel'), 'Chrome build must request sidePanel');
  console.log(`chrome-build: manifest valid, content script ${size} B`);
}

function firefoxBuild() {
  run('tsx', ['apps/extension/scripts/build.ts', 'firefox']);
  const dir = join(DIST, 'firefox');
  const m = readJson(join(dir, 'manifest.json'));
  checkCommonManifest(dir, m);
  assert(
    Array.isArray(m.background?.scripts) && !m.background.service_worker,
    'Firefox needs background.scripts',
  );
  assert(m.browser_specific_settings?.gecko?.id, 'Firefox needs a gecko id');
  for (const f of [...m.background.scripts, m.sidebar_action?.default_panel, m.options_ui?.page]) {
    assert(typeof f === 'string' && existsSync(join(dir, f)), `missing Firefox entry: ${f}`);
  }
  const lint = run('web-ext', ['lint', '--source-dir', dir, '--self-hosted', '--output', 'json'], {
    allowFail: true,
  });
  const report = JSON.parse(lint.stdout);
  assert(
    report.errors.length === 0,
    `web-ext lint errors: ${report.errors.map((e) => e.code).join(', ')}`,
  );
  console.log(
    `firefox-build: web-ext lint ${report.errors.length} errors, ${report.warnings.length} warnings`,
  );
}

function e2e() {
  run('tsx', ['apps/extension/scripts/build.ts', 'chrome']);
  const result = run('playwright', ['test', '--project=browser', '--reporter=json'], {
    allowFail: true,
  });
  const report = JSON.parse(result.stdout);
  const specs = report.suites.flatMap(function collect(s) {
    return [...(s.specs ?? []), ...(s.suites ?? []).flatMap(collect)];
  });
  const statuses = specs.flatMap((s) => s.tests.flatMap((t) => t.results.map((r) => r.status)));
  assert(result.status === 0, `playwright exited ${result.status}`);
  assert(specs.length >= 8, `expected ≥8 browser specs, found ${specs.length}`);
  assert(
    statuses.every((s) => s === 'passed'),
    `browser results: ${statuses.join(', ')}`,
  );
  assert(
    report.stats.unexpected === 0 && report.stats.skipped === 0,
    'unexpected or skipped browser tests',
  );
  console.log(`e2e: ${statuses.length}/${specs.length} real-Chromium tests passed`);
}

const REQUIRED_DOCS = [
  'PRD.md',
  'ARCHITECTURE.md',
  'TECHNICAL_DESIGN.md',
  'SECURITY.md',
  'THREAT_MODEL.md',
  'PRIVACY.md',
  'MODEL_ROUTING.md',
  'PERCEPTION.md',
  'ACTION_FIREWALL.md',
  'SKILLS.md',
  'MONITORING.md',
  'VOICE.md',
  'MULTILINGUAL.md',
  'BROWSER_SUPPORT.md',
  'PERFORMANCE.md',
  'TESTING.md',
  'SIH_VALIDATION.md',
  'DEPLOYMENT.md',
  'KNOWN_LIMITATIONS.md',
  'IMPLEMENTATION_STATUS.md',
  'FINAL_VALIDATION.md',
];

function docs() {
  for (const name of REQUIRED_DOCS) {
    const path = join(ROOT, 'docs', name);
    assert(existsSync(path), `missing docs/${name}`);
    const text = readFileSync(path, 'utf8');
    assert(/^\*\*Status:\*\* .+/m.test(text), `docs/${name} has no "**Status:**" line`);
  }
  console.log(`docs: ${REQUIRED_DOCS.length} documents present with status`);
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bre_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];

function hygiene() {
  const code = sourceFiles().filter((f) => !f.endsWith('scripts/verify/phase0.mjs'));
  for (const file of code) {
    const text = readFileSync(file, 'utf8');
    assert(!/\beval\s*\(/.test(text), `eval( found in ${relative(ROOT, file)}`);
    assert(!/\bnew\s+Function\s*\(/.test(text), `new Function( found in ${relative(ROOT, file)}`);
  }
  const all = walk(ROOT, SKIP_DIRS).filter(
    (f) => !/\.(png|jpg|ico)$/.test(f) && !f.endsWith('package-lock.json'),
  );
  for (const file of all) {
    const text = readFileSync(file, 'utf8');
    for (const p of SECRET_PATTERNS)
      assert(!p.test(text), `possible secret (${p}) in ${relative(ROOT, file)}`);
  }
  assert(existsSync(join(ROOT, '.env.example')), 'missing .env.example');
  assert(
    readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('.env'),
    '.env is not git-ignored',
  );
  const ci = join(ROOT, '.github/workflows/ci.yml');
  assert(existsSync(ci), 'missing CI workflow');
  const ciText = readFileSync(ci, 'utf8');
  for (const step of [
    'npm ci',
    'npm run lint',
    'npm run typecheck',
    'npm test',
    'npm run build',
    'lint:firefox',
    'test:browser',
  ]) {
    assert(ciText.includes(step), `CI workflow does not run: ${step}`);
  }
  console.log(
    `hygiene: ${code.length} source files clean, ${all.length} files scanned for secrets`,
  );
}

const GATES = {
  typecheck,
  lint,
  unit,
  'chrome-build': chromeBuild,
  'firefox-build': firefoxBuild,
  e2e,
  docs,
  hygiene,
};

const requested = process.argv[2];
const names = requested === 'all' ? Object.keys(GATES) : [requested];
let failed = false;
for (const name of names) {
  const gate = GATES[name];
  if (!gate) {
    console.error(`unknown gate "${name}". Use one of: ${Object.keys(GATES).join(', ')}, all`);
    process.exit(2);
  }
  try {
    gate();
    console.log(`PHASE0-VERIFY ${name} passed`);
  } catch (error) {
    failed = true;
    console.error(
      `PHASE0-VERIFY ${name} FAILED: ${error instanceof GateFailure ? error.message : error}`,
    );
  }
}
if (requested === 'all' && !failed) console.log(`PHASE0-VERIFY ALL ${names.length} passed`);
process.exit(failed ? 1 : 0);
