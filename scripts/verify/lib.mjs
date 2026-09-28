/**
 * Shared helpers for the Batch A verifiers (phase3.mjs, phase4.mjs). Every helper runs the real tool
 * and inspects structured output; failures throw GateFailure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BIN = join(ROOT, 'node_modules/.bin');
export const EVIDENCE = join(ROOT, 'evidence');

export class GateFailure extends Error {}
export function assert(condition, message) {
  if (!condition) throw new GateFailure(message);
}

export function run(cmd, args, { allowFail = false, bin = true, env = {} } = {}) {
  const result = spawnSync(bin ? join(BIN, cmd) : cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
  if (!allowFail && result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-30);
    throw new GateFailure(
      `\`${cmd} ${args.join(' ')}\` exited ${result.status}\n${tail.join('\n')}`,
    );
  }
  return result;
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'test-results'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function runtimeFiles() {
  return [
    ...walk(join(ROOT, 'packages')).filter((f) => f.includes('/src/')),
    ...walk(join(ROOT, 'apps/extension/src')),
  ].filter((f) => /\.(ts|tsx)$/.test(f));
}

export function vitestJson(args = []) {
  const out = join(mkdtempSync(join(tmpdir(), 'tm-vitest-')), 'report.json');
  run('vitest', ['run', '--reporter=json', `--outputFile=${out}`, ...args], { allowFail: true });
  return readJson(out);
}

export function suite(report, describe) {
  const tests = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.ancestorTitles.some((t) => t.startsWith(describe)));
  return {
    total: tests.length,
    passed: tests.filter((a) => a.status === 'passed').length,
    failed: tests.filter((a) => a.status !== 'passed').map((a) => a.title),
  };
}

export function requireSuite(report, describe, minimum) {
  const s = suite(report, describe);
  assert(s.total >= minimum, `"${describe}": expected ≥${minimum} tests, found ${s.total}`);
  assert(
    s.passed === s.total,
    `"${describe}": ${s.passed}/${s.total} passed; failing: ${s.failed.join(' | ')}`,
  );
  return s;
}

export function requireTest(report, needle) {
  const t = report.testResults
    .flatMap((r) => r.assertionResults)
    .find((a) => a.title.includes(needle));
  assert(t, `test missing: ${needle}`);
  assert(t.status === 'passed', `test failed: ${needle}`);
}

export function playwrightJson(args) {
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
    file: s.file,
    status: s.tests.flatMap((t) => t.results.map((r) => r.status)).at(-1) ?? 'missing',
    error: s.tests
      .flatMap((t) =>
        t.results.flatMap((r) => (r.error?.message ? [r.error.message.split('\n')[0]] : [])),
      )
      .join(' | '),
  }));
  return { exit: result.status, results, stats: report.stats };
}

/**
 * Failures that are properties of THIS machine's browser build, not of the code. Each entry names
 * the exact test and the exact error text; anything else fails the gate. Only applied when the
 * suite runs on an override Chromium (TM_CHROMIUM), and every tolerated failure is printed.
 */
const ENVIRONMENT_FAILURES = [
  {
    title: 'toolbar button is bound to the side panel',
    error: "Cannot read properties of undefined (reading 'getPanelBehavior')",
    why: 'this Chromium build has no chrome.sidePanel.getPanelBehavior',
  },
];

export function requireAllPassed({ results, stats }, minimum, label) {
  assert(
    results.length >= minimum,
    `${label}: expected ≥${minimum} tests, found ${results.length}`,
  );
  const failed = results.filter((r) => r.status !== 'passed');
  const tolerated = process.env.TM_CHROMIUM
    ? failed.filter((f) =>
        ENVIRONMENT_FAILURES.some((e) => f.title.includes(e.title) && f.error.includes(e.error)),
      )
    : [];
  const real = failed.filter((f) => !tolerated.includes(f));
  assert(
    real.length === 0,
    `${label} failures:\n${real.map((f) => `  ✘ ${f.title}: ${f.error}`).join('\n')}`,
  );
  assert(stats.skipped === 0, `${label}: skipped tests`);
  for (const t of tolerated) console.log(`  (environment) ${t.title}: ${t.error}`);
  return { results, tolerated: tolerated.length };
}

export function requireTitles(results, needles) {
  for (const needle of needles) {
    assert(
      results.some((r) => r.title.includes(needle) && r.status === 'passed'),
      `missing passing scenario: ${needle}`,
    );
  }
}

export const build = () => run('tsx', ['apps/extension/scripts/build.ts', 'chrome']);

export function phaseGate(runNode, script, gate, prefix) {
  const r = runNode(script, gate);
  assert(
    r.status === 0 && r.stdout.includes(`${prefix} ${gate} passed`),
    `${script} ${gate} failed:\n${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-10).join('\n')}`,
  );
}

export const node = (script, ...args) =>
  run('node', [script, ...args], { bin: false, allowFail: true });

/** Start a child process and wait until it prints `ready`. */
export function startProcess(cmd, args, env, ready) {
  return new Promise((resolveStart, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    const timer = setTimeout(() => reject(new GateFailure(`${cmd} did not start: ${out}`)), 15_000);
    const onData = (d) => {
      out += d.toString();
      if (out.includes(ready)) {
        clearTimeout(timer);
        resolveStart(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new GateFailure(`${cmd} exited ${code}: ${out}`)));
  });
}

/** Run gates by name; print `<PREFIX> <name> passed` or FAILED; exit non-zero on any failure. */
export async function main(prefix, gates) {
  const requested = process.argv[2];
  const names = requested === 'all' ? Object.keys(gates) : [requested];
  let failed = false;
  for (const name of names) {
    const fn = gates[name];
    if (!fn) {
      console.error(`unknown gate "${name}". Use one of: ${Object.keys(gates).join(', ')}, all`);
      process.exit(2);
    }
    try {
      await fn();
      console.log(`${prefix} ${name} passed`);
    } catch (error) {
      failed = true;
      console.error(
        `${prefix} ${name} FAILED: ${error instanceof GateFailure ? error.message : (error?.stack ?? error)}`,
      );
    }
  }
  if (requested === 'all' && !failed) console.log(`${prefix} ALL ${names.length} passed`);
  process.exit(failed ? 1 : 0);
}
