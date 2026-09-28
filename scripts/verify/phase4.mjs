#!/usr/bin/env node
/**
 * Phase 4 acceptance verifier (docs/phases/PHASE_4_GATES.md).
 *
 *   node scripts/verify/phase4.mjs <regression|lazy|privacy|grounding|runner|browser|docs|all>
 */
import { existsSync, readFileSync } from 'node:fs';
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

const VISION_TESTS = [
  'packages/agent-core/test/vision.test.ts',
  'packages/models/test/models.test.ts',
];

function regression() {
  const report = vitestJson();
  assert(
    report.success && report.numFailedTests === 0,
    `${report.numFailedTests} unit tests failed`,
  );
  assert(report.numTotalTests >= 387, `only ${report.numTotalTests} unit tests`);
  for (const gate of ['contracts', 'routing', 'privacy', 'authority', 'runner', 'laya-adapter']) {
    phaseGate(node, 'scripts/verify/phase3.mjs', gate, 'PHASE3-VERIFY');
  }
  phaseGate(node, 'scripts/verify/phase2.mjs', 'gate', 'PHASE2-VERIFY');
  console.log(
    `regression: ${report.numPassedTests}/${report.numTotalTests} unit tests; Phase 3 gates hold; only the gate reaches the network`,
  );
}

function lazy() {
  const report = vitestJson(VISION_TESTS);
  requireSuite(report, 'vision — when it is worth looking', 3);
  requireTest(report, 'a page code can ground makes 0 vision calls and 0 captures');
  requireTest(report, 'a text-only page where nothing matches never triggers vision');
  requireTest(report, 'no vision tier or no capture: hand over exactly as before');
  // Static: captures happen in exactly two places — the gated vision fallback (#visualGround) and
  // the screenshot-walkthrough skill the user asks for explicitly (Phase 6). The vision model is
  // called only in #visualGround.
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  const body = (name) => {
    const start = runner.indexOf(`async ${name}(`);
    assert(start >= 0, `${name} missing`);
    const next = runner.indexOf('\n  async #', start + 10);
    return runner.slice(start, next < 0 ? undefined : next);
  };
  const calls =
    runner.match(/captureVisible\?\.\(|captureVisible\?\.bind|\.captureVisible\(/g) ?? [];
  assert(
    calls.length === 2,
    `captureVisible referenced ${calls.length}× in the runner (expected 2)`,
  );
  assert(
    /captureVisible\?\.bind/.test(body('#visualGround')),
    'vision capture outside #visualGround',
  );
  assert(/captureVisible\?\.bind/.test(body('#skillWalkthrough')), 'unexpected capture site');
  const locates = runner.match(/\.locate\?\.bind|\.locate\(/g) ?? [];
  assert(
    locates.length === 1 && /locate\?\.bind/.test(body('#visualGround')),
    'vision model called outside #visualGround',
  );
  assert(
    /if \(!locate \|\| !capture \|\| !visionWorthTrying\(obs\)\) return null;/.test(runner),
    'vision is not gated on insufficiency',
  );
  console.log(
    'lazy: vision only after grounding fails on a page with visual-only elements; 0 captures otherwise',
  );
}

function privacy() {
  const report = vitestJson([...VISION_TESTS, 'packages/privacy/test/privacy.test.ts']);
  requireTest(report, 'the gate: images only for visual grounding, only redacted, bounded');
  requireTest(report, 'screenshots never go to a remote gateway');
  requireTest(report, 'what vision receives: redacted image, tokenized target');
  requireTest(report, 'sends the redacted image to the local model by placeholder');
  const capture = readFileSync(join(ROOT, 'apps/extension/src/background/capture.ts'), 'utf8');
  assert(
    /fillRect\(/.test(capture) && /redacted: true/.test(capture),
    'capture does not paint regions over',
  );
  const host = readFileSync(join(ROOT, 'apps/extension/src/background/host.ts'), 'utf8');
  assert(
    /PRIVACY_REGIONS/.test(host) && /redactCapture\(shot, regions[,)]/.test(host),
    'host does not redact before returning',
  );
  assert(!/return shot\b|image: shot/.test(host), 'raw capture escapes the host');
  const regions = readFileSync(join(ROOT, 'packages/privacy/src/detect.ts'), 'utf8');
  assert(/export function sensitiveRegions/.test(regions), 'in-page region scan missing');
  console.log(
    'privacy: in-page region scan → local paint-over → gate (images: grounding only, redacted, bounded) → local model only',
  );
}

function grounding() {
  const report = vitestJson(VISION_TESTS);
  requireSuite(report, 'vision — regions to elements', 2);
  requireTest(report, 'vision answers are strict: a box inside the image');
  requireTest(
    report,
    'grounds a region to the best-overlapping visible interactive element, or to nothing',
  );
  const runner = readFileSync(join(ROOT, 'packages/agent-core/src/runner.ts'), 'utf8');
  assert(!/type: 'CLICK', x:|clickAt|coordinates:/.test(runner), 'coordinate clicks present');
  console.log(
    'grounding: strict boxes → page coordinates → one DOM element or nothing; no coordinate clicks',
  );
}

function runner() {
  const report = vitestJson(VISION_TESTS);
  const s = requireSuite(report, 'vision — runner fallback through the firewall', 6);
  requireTest(
    report,
    '"open the red one" on image tiles: model unsure → vision locates → one verified click',
  );
  requireTest(report, 'a payment control located by vision is handed over, never clicked');
  requireTest(report, 'an injected element located by vision is blocked by the firewall');
  console.log(`runner: ${s.passed} fallback scenarios through the firewall`);
}

function browser() {
  build();
  const vision = playwrightJson(['--project=browser', 'tests/browser/vision.spec.ts']);
  requireAllPassed(vision, 2, 'visual fallback (real Chrome)');
  requireTitles(vision.results, [
    'redacted capture → vision → the red tile opens',
    'makes no capture at all',
  ]);
  const all = playwrightJson(['--project=browser']);
  const { results, tolerated } = requireAllPassed(all, 44, 'real-Chrome suite');
  console.log(
    `browser: pixel-checked redaction and visual open in Chromium; ${results.length - tolerated}/${results.length} real-Chrome tests pass${tolerated ? ` (${tolerated} environment-only)` : ''}`,
  );
}

function docs() {
  const doc = readFileSync(join(ROOT, 'docs/PERCEPTION.md'), 'utf8');
  for (const needle of [
    'Level 4',
    'visionWorthTrying',
    'sensitiveRegions',
    'groundRegion',
    'Florence-2',
    'WebGPU',
    'bench:models -- --vision',
  ]) {
    assert(doc.includes(needle), `PERCEPTION.md does not cover "${needle}"`);
  }
  assert(existsSync(join(ROOT, 'scripts/bench/vision.ts')), 'vision benchmark missing');
  const bench = readFileSync(join(ROOT, 'scripts/bench/vision.ts'), 'utf8');
  for (const m of ['localizationAccuracy', 'meanIoU', 'warmP50Ms', 'ollamaPs'])
    assert(bench.includes(m), `benchmark lacks ${m}`);
  console.log(
    'docs: level 4 documented; vision benchmark measures accuracy, IoU, latency and memory',
  );
}

await main('PHASE4-VERIFY', { regression, lazy, privacy, grounding, runner, browser, docs });
