/**
 * Real-model benchmark (run on the machine with the models — the owner's Mac):
 *
 *   npm run bench:models                       # Laya + local model, 3 runs each
 *   npm run bench:models -- --runs 5 --laya-token <token>
 *   npm run bench:models -- --vision           # also the Phase 4 visual-grounding set
 *
 * It uses the exact production path — createIntelligence → privacy gate → Ollama / Laya adapter —
 * with synthetic requests and pages, and writes evidence/model-bench.json: availability, cold and
 * warm latency (p50/p95), valid-answer rate and accuracy against the expected reading.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, type Settings } from '@techie-mind/config';
import { SanitizedObservation, type IntentProfile } from '@techie-mind/contracts';
import {
  createIntelligence,
  TransportError,
  type ModelCall,
  type ModelTransport,
} from '@techie-mind/models';
import { gatedFetch, OutboundPrivacyGate, PrivacyGateError } from '@techie-mind/privacy';
import { visionBench } from './vision.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const RUNS = Number(option('runs', '3'));
const OUT = option('out', 'evidence/model-bench.json');

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  model: {
    ...DEFAULT_SETTINGS.model,
    ollama: {
      baseUrl: option('ollama', DEFAULT_SETTINGS.model.ollama.baseUrl),
      model: option('model', DEFAULT_SETTINGS.model.ollama.model),
    },
    laya: {
      enabled: !flag('no-laya'),
      adapterUrl: option('laya', DEFAULT_SETTINGS.model.laya.adapterUrl),
      token: option('laya-token', process.env['TECHIE_MIND_LAYA_TOKEN'] ?? ''),
    },
  },
};

/** Same transport as the extension: gate first, no cookies, bounded time. */
export const transport: ModelTransport = {
  async send(call: ModelCall) {
    const gate = new OutboundPrivacyGate();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), call.timeoutMs);
    try {
      const res = await gatedFetch(
        gate,
        {
          purpose: 'model',
          url: call.url,
          method: call.method,
          payload: call.request,
          ...(call.wire !== undefined ? { wire: call.wire } : {}),
          ...(call.headers ? { headers: call.headers } : {}),
          ...(call.images ? { images: call.images } : {}),
        },
        { signal: controller.signal },
      );
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    } catch (error) {
      if (error instanceof PrivacyGateError) throw new TransportError('blocked', error.message);
      if (controller.signal.aborted) throw new TransportError('timeout', 'timeout');
      throw new TransportError(
        'unreachable',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  },
};

const INTENT: IntentProfile = {
  intent: 'unknown',
  targetDomain: null,
  directNavigation: false,
  action: null,
  query: null,
  constraints: [],
  entities: [],
  language: 'en',
  riskLevel: 'LOW',
  requiresConfirmation: false,
  confidence: 0.3,
  resolvedBy: 'deterministic',
  targetSource: 'CURRENT_PAGE',
  navigationPolicy: 'REUSE_CURRENT_CONTEXT',
  siteName: null,
  ordinal: null,
};

/** A synthetic product results page, as the model would see it (sanitized). */
const RESULTS_PAGE = SanitizedObservation.parse({
  observationId: 'obs-bench-1',
  version: 1,
  origin: 'https://shop.example.com',
  path: '/search',
  title: 'phones - Shop',
  createdAt: 0,
  nodes: [
    ['el-1', 'searchbox', 'Search for products'],
    ['el-2', 'heading', 'Results for phones'],
    ['el-3', 'link', 'Apple iPhone 15 (Blue, 128 GB) — ₹69,900'],
    ['el-4', 'link', 'Samsung Galaxy S24 (Black, 256 GB) — ₹74,999'],
    ['el-5', 'link', 'Google Pixel 8a (Aloe, 128 GB) — ₹39,999'],
    ['el-6', 'link', 'Redmi 13C (Green, 64 GB) — ₹8,499'],
    ['el-7', 'button', 'Sort by price'],
  ].map(([id, role, name], i) => ({
    nodeId: id,
    role,
    name,
    text: null,
    interactive: role !== 'heading',
    editable: role === 'searchbox',
    bbox: { x: 0, y: i * 60, width: 600, height: 50 },
  })),
  findings: [],
  redactionCount: 0,
  sanitized: true,
});

const LAYA_SET: Array<[string, string]> = [
  ['iphone 15', 'search'],
  ['budget phones under 10000', 'search'],
  ['open the samsung one', 'pick_result'],
  ['the one with 256 GB', 'pick_result'],
  ['I want to hear something by Arijit Singh', 'play_media'],
  ['put on some lofi beats', 'play_media'],
  ['scroll down a bit', 'page_command'],
  ['make the text bigger', 'page_command'],
  ['take me to wikipedia', 'open_website'],
  ['hmm not sure', 'unclear'],
];

type Expect =
  { kind: 'element'; elementId: string } | { kind: 'intent'; action: string; query: string };
const MODEL_SET: Array<[string, Expect]> = [
  ['open the samsung one', { kind: 'element', elementId: 'el-4' }],
  ['show me the one with 256 GB', { kind: 'element', elementId: 'el-4' }],
  ['the cheapest one please', { kind: 'element', elementId: 'el-6' }],
  ['open the google phone', { kind: 'element', elementId: 'el-5' }],
  [
    'I want to hear something by Arijit Singh',
    { kind: 'intent', action: 'search_and_play', query: 'Arijit Singh' },
  ],
  ['find me a red phone case', { kind: 'intent', action: 'search', query: 'red phone case' }],
];

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};

async function benchLaya(ai: ReturnType<typeof createIntelligence>) {
  const latencies: number[] = [];
  let valid = 0;
  let correct = 0;
  let escalated = 0;
  let first: number | null = null;
  const outcomes: Record<string, number> = {};
  for (let run = 0; run < RUNS; run++) {
    for (const [text, expected] of LAYA_SET) {
      const r = await ai.classify({
        taskId: `task-bench-${run}`,
        text,
        intent: INTENT,
        page: { host: 'shop.example.com', canSearch: true, resultCount: 4 },
      });
      outcomes[r.usage.outcome] = (outcomes[r.usage.outcome] ?? 0) + 1;
      if (first === null) first = r.usage.latencyMs;
      else latencies.push(r.usage.latencyMs);
      if (!r.value) continue;
      valid += 1;
      if (r.value.escalate) escalated += 1;
      if (r.value.category === expected) correct += 1;
    }
  }
  const total = LAYA_SET.length * RUNS;
  return {
    calls: total,
    outcomes,
    validRate: valid / total,
    accuracy: valid ? correct / valid : 0,
    escalationRate: valid ? escalated / valid : 0,
    coldMs: first,
    warmP50Ms: pct(latencies, 50),
    warmP95Ms: pct(latencies, 95),
  };
}

async function benchModel(ai: ReturnType<typeof createIntelligence>) {
  const latencies: number[] = [];
  let valid = 0;
  let correct = 0;
  let first: number | null = null;
  const outcomes: Record<string, number> = {};
  const misses: string[] = [];
  for (let run = 0; run < RUNS; run++) {
    for (const [text, expected] of MODEL_SET) {
      const r = await ai.interpret({
        taskId: `task-bench-${run}`,
        text,
        intent: INTENT,
        observation: RESULTS_PAGE,
      });
      outcomes[r.usage.outcome] = (outcomes[r.usage.outcome] ?? 0) + 1;
      if (first === null) first = r.usage.latencyMs;
      else latencies.push(r.usage.latencyMs);
      const v = r.value;
      if (!v) continue;
      valid += 1;
      const ok =
        expected.kind === 'element'
          ? v.kind === 'element' && v.elementId === expected.elementId
          : v.kind === 'intent' &&
            v.action === expected.action &&
            (v.query ?? '').toLowerCase() === expected.query.toLowerCase();
      if (ok) correct += 1;
      else if (run === 0) misses.push(`${text} → ${JSON.stringify(v)}`);
    }
  }
  const total = MODEL_SET.length * RUNS;
  return {
    model: settings.model.ollama.model,
    calls: total,
    outcomes,
    validRate: valid / total,
    accuracy: valid ? correct / valid : 0,
    coldMs: first,
    warmP50Ms: pct(latencies, 50),
    warmP95Ms: pct(latencies, 95),
    misses,
  };
}

async function main() {
  const ai = createIntelligence({ settings, transport });
  console.log(`Benchmarking ${settings.model.ollama.model} and Laya (${RUNS} runs)…`);
  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    machine: `${process.platform}/${process.arch}`,
    runs: RUNS,
    laya: settings.model.laya.enabled ? await benchLaya(ai) : 'disabled',
    model: await benchModel(ai),
  };
  if (flag('vision')) report['vision'] = await visionBench(settings, transport, RUNS);
  mkdirSync('evidence', { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${OUT}`);
}

await main();
