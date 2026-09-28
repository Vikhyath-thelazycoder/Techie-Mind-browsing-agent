#!/usr/bin/env node
/**
 * Phase 3 acceptance verifier (docs/phases/PHASE_3_GATES.md). Each subcommand runs the real tool,
 * inspects structured output, and prints `PHASE3-VERIFY <name> passed` only after every assertion.
 *
 *   node scripts/verify/phase3.mjs <regression|contracts|routing|privacy|authority|runner|laya-adapter|browser|docs|all>
 */
import { existsSync, readFileSync } from 'node:fs';
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
  startProcess,
  vitestJson,
} from './lib.mjs';

const MODEL_TESTS = [
  'packages/models/test/models.test.ts',
  'packages/agent-core/test/models.test.ts',
];

function regression() {
  const report = vitestJson();
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} unit tests failed`,
  );
  assert(report.numTotalTests >= 370, `only ${report.numTotalTests} unit tests`);
  phaseGate(node, 'scripts/verify/phase1.mjs', 'static', 'PHASE1-VERIFY');
  phaseGate(node, 'scripts/verify/phase1.mjs', 'generic', 'PHASE1-VERIFY');
  phaseGate(node, 'scripts/verify/phase2.mjs', 'gate', 'PHASE2-VERIFY');
  console.log(
    `regression: ${report.numPassedTests}/${report.numTotalTests} unit tests; no hard-coded phrases; only the gate reaches the network`,
  );
}

function contracts() {
  const report = vitestJson(MODEL_TESTS);
  const s = requireSuite(report, 'model contracts — strict parsing', 3);
  requireTest(report, 'rejects everything else — never repaired, never guessed');
  requireTest(report, 'Laya answers are typed choices only');
  // The contracts themselves are strict objects.
  const src = readFileSync(join(ROOT, 'packages/contracts/src/model.ts'), 'utf8');
  for (const name of ['LayaClassification', 'ModelInterpretation', 'ModelUsage']) {
    assert(
      new RegExp(`export const ${name} = z\\.(strictObject|discriminatedUnion)`).test(src),
      `${name} is not strict`,
    );
  }
  console.log(
    `contracts: ${s.passed} strict-parsing tests; Laya/interpretation/usage contracts strict`,
  );
}

function routing() {
  const report = vitestJson(MODEL_TESTS);
  requireSuite(report, 'model routing — which requests reach a model', 2);
  const r = requireSuite(report, 'model routing — runner (Code → Laya → model → ask)', 7);
  const i = requireSuite(report, 'intelligence — tiers, availability and privacy', 5);
  requireTest(report, '0 model calls for a confident command, even with models configured');
  requireTest(report, 'never substitutes another model');
  requireTest(report, 'models unavailable: an ordinary query continues with the code reading');
  requireTest(report, 'the model abstains → the user is asked');
  console.log(`routing: ${r.passed} runner routing tests, ${i.passed} tier-client tests`);
}

function privacy() {
  const report = vitestJson([...MODEL_TESTS, 'packages/privacy/test/privacy.test.ts']);
  requireSuite(report, 'model routing — through the real privacy gate', 1);
  requireSuite(report, 'model page summary', 1);
  requireTest(report, 'personal data reaches the model only as tokens; the page only sanitized');
  requireTest(report, 'the privacy gate refuses non-loopback model endpoints unless configured');
  requireTest(report, 'maps failures to outcomes: offline, timeout, malformed and blocked');
  requireSuite(report, 'outbound privacy gate', 4);
  // Static: model clients never touch the network themselves; the runner hands models only
  // sanitized observations and redacted text.
  const models = runtimeFiles().filter((f) => f.includes('/packages/models/src/'));
  assert(models.length >= 5, 'models package missing');
  for (const f of models) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert(
      !/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code),
      `${relative(ROOT, f)} reaches the network`,
    );
  }
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  assert(
    /sanitizeObservation\(page\.obs, this\.#vault\)/.test(runner),
    'runner does not sanitize the page for models',
  );
  assert(
    /redactText\(this\.task\.text, this\.#vault\)/.test(runner),
    'runner does not redact the request for models',
  );
  const transport = readFileSync(join(ROOT, 'apps/extension/src/background/models.ts'), 'utf8');
  assert(
    /gatedFetch\(/.test(transport) && /purpose: 'model'/.test(transport),
    'extension model transport is not gated',
  );
  console.log(
    'privacy: gate-checked ModelRequests; tokens only; sanitized summaries; no direct network in model code',
  );
}

function authority() {
  const report = vitestJson(MODEL_TESTS);
  const s = requireSuite(report, 'model routing — authority stays local', 6);
  for (const t of [
    'a query the user never said is refused',
    'a site the user never named is refused',
    'an element that was not on the page shown is refused',
    'an injected element picked by the model is blocked by the firewall',
    'a payment control picked by the model hands over',
  ]) {
    requireTest(report, t);
  }
  console.log(
    `authority: ${s.passed} tests — code re-checks every model answer, the firewall authorizes every action`,
  );
}

function runner() {
  const report = vitestJson(MODEL_TESTS);
  requireTest(
    report,
    '"open the samsung one": Laya escalates, the model picks the element, one verified click',
  );
  requireTest(
    report,
    '"I want to hear something by Arijit Singh": the model extracts the query from the user words',
  );
  requireTest(report, 'Laya confirms a bare follow-up query');
  requireTest(report, 'real task ids, real ModelRequests, real gate');
  console.log(
    'runner: model-routed follow-ups complete with verified steps, tier records and latency',
  );
}

async function layaAdapter() {
  const script = 'scripts/laya/laya_adapter.py';
  const { spawnSync } = await import('node:child_process');
  const compiled = spawnSync('python3', ['-m', 'py_compile', script], { cwd: ROOT });
  assert(compiled.status === 0, `adapter does not compile: ${compiled.stderr}`);
  const src = readFileSync(join(ROOT, script), 'utf8');
  assert(/HOST = "127\.0\.0\.1"/.test(src), 'adapter must bind loopback only');
  assert(existsSync(join(ROOT, 'scripts/laya/com.techiemind.laya.plist')), 'launchd plist missing');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = await startProcess(
    'python3',
    [script],
    {
      TECHIE_MIND_LAYA_FAKE: '1',
      TECHIE_MIND_LAYA_TOKEN: 'gate-token',
      TECHIE_MIND_LAYA_PORT: String(port),
    },
    'laya adapter ready',
  );
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${base}/health`)).json();
    assert(health.ok === true && health.warm === true, 'health endpoint');
    const post = (body, token = 'gate-token') =>
      fetch(`${base}/v1/classify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-techie-mind-laya-token': token },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const choices = [
      'search',
      'open_website',
      'play_media',
      'pick_result',
      'page_command',
      'unclear',
    ];
    assert(
      (await post({ text: 'iphone 15', page: null, choices }, 'wrong')).status === 401,
      'token not checked',
    );
    assert((await post('x'.repeat(20_000))).status === 413, 'request size not bounded');
    assert(
      (await post({ text: 'x', page: null, choices: ['delete_everything'] })).status === 400,
      'choices not validated',
    );
    const ok = await post({
      text: 'iphone 15',
      page: { host: 'x.test', canSearch: true, resultCount: 3 },
      choices,
    });
    const answer = await ok.json();
    assert(ok.status === 200 && choices.includes(answer.category), 'no typed answer');
    assert(
      typeof answer.confidence === 'number' && typeof answer.escalate === 'boolean',
      'answer not typed',
    );
    const up = await (await post({ text: 'open the samsung one', page: null, choices })).json();
    assert(up.escalate === true, 'unsure answers must escalate');
    console.log(
      `laya-adapter: loopback, token, 16 KB limit, typed answers, escalation — fake mode on :${port}`,
    );
  } finally {
    child.kill();
  }
}

function browser() {
  build();
  const models = playwrightJson(['--project=browser', 'tests/browser/models.spec.ts']);
  requireAllPassed(models, 3, 'model routing (real Chrome)');
  requireTitles(models.results, [
    'Laya → local model → one verified click',
    'nothing personal is sent',
    'models not running',
  ]);
  const all = playwrightJson(['--project=browser']);
  const { results, tolerated } = requireAllPassed(all, 42, 'real-Chrome suite');
  console.log(
    `browser: ${models.results.length} model-routing scenarios; ${results.length - tolerated}/${results.length} real-Chrome tests pass${tolerated ? ` (${tolerated} environment-only)` : ''}`,
  );
}

function docs() {
  const doc = readFileSync(join(ROOT, 'docs/MODEL_ROUTING.md'), 'utf8');
  for (const needle of [
    'Laya',
    'Ollama',
    'CODE_CONFIDENCE',
    'timeout',
    'privacy gate',
    'abstain',
    'never substitute',
    'bench:models',
  ]) {
    assert(doc.includes(needle), `MODEL_ROUTING.md does not cover "${needle}"`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert(pkg.scripts['bench:models'], 'bench:models script missing');
  assert(existsSync(join(ROOT, 'scripts/bench/models.ts')), 'benchmark script missing');
  console.log('docs: model routing documented; benchmark script present');
}

await main('PHASE3-VERIFY', {
  regression,
  contracts,
  routing,
  privacy,
  authority,
  runner,
  'laya-adapter': layaAdapter,
  browser,
  docs,
});
