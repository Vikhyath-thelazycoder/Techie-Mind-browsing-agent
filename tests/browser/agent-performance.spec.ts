import { mkdirSync, writeFileSync } from 'node:fs';
import type { StageTimings } from '@techie-mind/contracts';
import { percentile } from '@techie-mind/telemetry';
import { explain, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';

/**
 * Phase 1 per-stage latency on local fixture sites (real Chromium, no network variance).
 * Different queries every run so nothing can be cached or specialised.
 */
test.describe.configure({ timeout: 300_000 });

const QUERIES = [
  'trail running shoes',
  'ceramic coffee mugs',
  'wireless keyboard',
  'yoga mat',
  'stainless steel bottle',
  'noise cancelling headphones',
  'linen bed sheets',
  'kids story books',
  'garden hose',
  'desk lamp',
];

test('agent stage latency (P50/P95) over 20 fixture tasks', async ({ context, extensionId }) => {
  const samples: StageTimings[] = [];
  let i = 0;
  for (const query of QUERIES) {
    for (const site of ['form.fixture.test', 'spa.fixture.test']) {
      const run = await runAgentTask(context, extensionId, `open ${site} and search for ${query}`);
      expect(run.result.status, explain(run)).toBe('COMPLETED');
      samples.push(run.result.timings);
      i += 1;
    }
  }
  const stages = [
    'intentMs',
    'contextMs',
    'routeMs',
    'resolutionMs',
    'privacyMs',
    'firewallMs',
    'navigationMs',
    'observationMs',
    'groundingMs',
    'actionMs',
    'verificationMs',
    'waitMs',
    'totalMs',
  ] as const;
  const summary = Object.fromEntries(
    stages.map((k) => {
      const values = samples.map((s) => s[k]);
      return [
        k,
        { p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) },
      ];
    }),
  );
  const evidence = {
    measuredAt: new Date().toISOString(),
    environment: 'Playwright Chromium (headless), local fixture sites via request routing',
    tasks: i,
    modelCalls: samples.reduce((n, s) => n + s.modelCalls, 0),
    observationsPerTask: percentile(
      samples.map((s) => s.observations),
      50,
    ),
    stages: summary,
  };
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/perf-phase1-fixtures.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  expect(evidence.modelCalls).toBe(0);
});
