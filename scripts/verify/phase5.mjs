#!/usr/bin/env node
/**
 * Phase 5 acceptance verifier (docs/phases/PHASE_5_GATES.md).
 *
 *   node scripts/verify/phase5.mjs <regression|extraction|commands|ecommerce|forms|output|media|browser|all>
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  runtimeFiles,
  vitestJson,
} from './lib.mjs';

const P5 = [
  'packages/agent-core/test/workflows.test.ts',
  'packages/perception/test/extract.test.ts',
  'packages/perception/test/executor.test.ts',
  'packages/agent-core/test/navigation.test.ts',
];

function regression() {
  const report = vitestJson();
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} unit tests failed`,
  );
  assert(report.numTotalTests >= 416, `only ${report.numTotalTests} unit tests`);
  for (const gate of ['contracts', 'routing', 'privacy', 'authority', 'runner']) {
    phaseGate(node, 'scripts/verify/phase3.mjs', gate, 'PHASE3-VERIFY');
  }
  for (const gate of ['lazy', 'privacy', 'grounding', 'runner']) {
    phaseGate(node, 'scripts/verify/phase4.mjs', gate, 'PHASE4-VERIFY');
  }
  phaseGate(node, 'scripts/verify/phase1.mjs', 'static', 'PHASE1-VERIFY');
  phaseGate(node, 'scripts/verify/phase1.mjs', 'generic', 'PHASE1-VERIFY');
  phaseGate(node, 'scripts/verify/phase2.mjs', 'gate', 'PHASE2-VERIFY');
  console.log(
    `regression: ${report.numPassedTests}/${report.numTotalTests} unit tests; Phase 1–4 gates hold`,
  );
}

function extraction() {
  const report = vitestJson(P5);
  requireTest(report, 'reads Indian and other currency formats');
  requireSuite(report, 'extractItems — generic, no selectors', 4);
  requireSuite(report, 'Phase 5 — extraction and constraints', 2);
  requireTest(report, '"open the cheapest one" opens the cheapest item — no model, one click');
  // No site-specific selectors in the extractor.
  const src = readFileSync(join(ROOT, 'packages/perception/src/extract.ts'), 'utf8');
  assert(
    !/flipkart|amazon|youtube|myntra|\.s-result|_4rR01T|data-asin/i.test(src),
    'site-specific code in the extractor',
  );
  console.log(
    'extraction: generic items + prices on differently built pages; constraints and "cheapest" without a model',
  );
}

function commands() {
  const report = vitestJson(P5);
  requireSuite(report, 'Phase 5 — page commands', 2);
  requireTest(report, 'Phase 5: page commands are actions on the open page, never web searches');
  requireTest(report, 'B2: browser commands the agent cannot do yet are refused honestly');
  console.log(
    'commands: scroll / back / forward executed and verified; unsupported ones still refused honestly',
  );
}

function ecommerce() {
  const report = vitestJson(P5);
  const s = requireSuite(report, 'Phase 5 — ecommerce stops before payment', 2);
  console.log(
    `ecommerce: ${s.passed} tests — add to cart verified, cart opens, checkout control handed over`,
  );
}

function forms() {
  const report = vitestJson([...P5, 'packages/security/test/firewall.test.ts']);
  requireSuite(report, 'Phase 5 — forms from the encrypted profile', 2);
  requireTest(report, 'SELECT sets a dropdown by option text or value');
  requireTest(
    report,
    'TYPE with a vault token types only the value resolved for exactly that token',
  );
  const store = readFileSync(join(ROOT, 'apps/extension/src/shared/profile-store.ts'), 'utf8');
  assert(
    /generateKey\(\{ name: 'AES-GCM', length: 256 \}, false/.test(store),
    'profile key is not non-extractable AES-GCM',
  );
  assert(!/console\./.test(store), 'profile store logs');
  // The Action contract never carries the profile value; only ExecuteCommand.resolved does.
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  assert(
    /input: \{ vaultToken: token \}/.test(runner),
    'form values are not typed through vault tokens',
  );
  console.log(
    'forms: meaning-based mapping; vault tokens; verified; never submitted; profile encrypted at rest',
  );
}

function output() {
  const report = vitestJson(P5);
  requireSuite(report, 'Phase 5 — summaries', 2);
  const tasks = readFileSync(join(ROOT, 'apps/extension/src/background/tasks.ts'), 'utf8');
  assert(
    /output: redactOutput\(result\.output\)/.test(tasks),
    'history does not redact task output',
  );
  console.log(
    'output: extractive and model summaries from redacted text; output redacted in history',
  );
}

function media() {
  const report = vitestJson(P5);
  requireSuite(report, 'Phase 5 — trusted media clicks', 2);
  const manifest = readFileSync(join(ROOT, 'apps/extension/scripts/manifest.ts'), 'utf8');
  assert(/'debugger'/.test(manifest), 'debugger permission missing');
  // Trusted input only: the adapter (mechanism), the extension host (element → point) and the
  // runner's #execute, which calls it only after the firewall authorized the CLICK.
  const allowed = new Set([
    'apps/extension/src/background/host.ts',
    'packages/browser/src/adapter.ts',
    'packages/agent-core/src/runner.ts',
  ]);
  const callers = runtimeFiles()
    .filter((f) => /trustedClick(?:At)?\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f));
  const outside = callers.filter((f) => !allowed.has(f));
  assert(outside.length === 0, `trusted input reachable from: ${outside.join(', ')}`);
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  const authorize = runner.indexOf('const decision = await this.#authorize(action, obs);');
  const trusted = runner.indexOf('await trustedClick(this.#tab, target.nodeId)');
  assert(
    authorize > 0 && trusted > authorize,
    'trusted click is not after the firewall in #execute',
  );
  console.log(
    'media: trusted click after the firewall; switch-off falls back to the Press-Play handover',
  );
}

function browser() {
  build();
  const wf = playwrightJson(['--project=browser', 'tests/browser/workflows.spec.ts']);
  requireAllPassed(wf, 6, 'Phase 5 workflows (real Chrome)');
  requireTitles(wf.results, [
    'laptops under ₹50,000',
    '"add it to cart" is verified',
    '"fill my delivery address"',
    '"summarize this page"',
    'a trusted click lets playback start with sound',
    'asks you to press Play',
  ]);
  const all = playwrightJson(['--project=browser']);
  const { results, tolerated } = requireAllPassed(all, 52, 'real-Chrome suite');
  console.log(
    `browser: ${wf.results.length} workflow scenarios; ${results.length - tolerated}/${results.length} real-Chrome tests pass${tolerated ? ` (${tolerated} environment-only)` : ''}`,
  );
}

await main('PHASE5-VERIFY', {
  regression,
  extraction,
  commands,
  ecommerce,
  forms,
  output,
  media,
  browser,
});
