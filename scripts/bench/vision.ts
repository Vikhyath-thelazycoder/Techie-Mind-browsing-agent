/**
 * Phase 4 vision benchmark (part of `npm run bench:models -- --vision`). Renders a visual-only page
 * in Chromium (image tiles and icon buttons with no accessible names), takes the ground-truth boxes
 * from the DOM, sends the screenshot through the production vision path (privacy gate → Ollama) and
 * scores localization: hit = the answer's centre falls inside the right element; IoU; latency; the
 * model's memory as reported by Ollama.
 */
import { chromium } from '@playwright/test';
import type { Settings } from '@techie-mind/config';
import type { IntentProfile } from '@techie-mind/contracts';
import { createIntelligence, type ModelTransport } from '@techie-mind/models';

export const VISION_PAGE = `<!doctype html><html><head><style>
body{font-family:sans-serif;margin:0;background:#fafafa}
header{display:flex;gap:18px;padding:14px 20px;background:#fff;border-bottom:1px solid #ddd;align-items:center}
header button{width:40px;height:40px;border:0;background:none}
main{display:grid;grid-template-columns:repeat(3,220px);gap:24px;padding:24px}
.tile{display:block;width:220px;height:220px;border-radius:12px;background:#fff;border:1px solid #ddd;position:relative}
.shape{position:absolute;inset:40px;border-radius:50%}
</style></head><body>
<header><span style="font-weight:700;font-size:20px">Shop</span><span style="flex:1"></span>
<button id="search"><svg viewBox="0 0 24 24" width="28" height="28"><circle cx="10" cy="10" r="7" fill="none" stroke="#333" stroke-width="2.5"/><line x1="15" y1="15" x2="22" y2="22" stroke="#333" stroke-width="2.5"/></svg></button>
<button id="heart"><svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 21s-8-5.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.5-8 11-8 11z" fill="#e33"/></svg></button>
<button id="cart"><svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 4h3l3 11h10l3-8H7" fill="none" stroke="#333" stroke-width="2"/><circle cx="10" cy="19" r="1.8" fill="#333"/><circle cx="18" cy="19" r="1.8" fill="#333"/></svg></button>
</header><main>
<a class="tile" id="red" href="#1"><div class="shape" style="background:#d22"></div></a>
<a class="tile" id="blue" href="#2"><div class="shape" style="background:#1e5bd8"></div></a>
<a class="tile" id="green" href="#3"><div class="shape" style="background:#1a9e3a;border-radius:8px"></div></a>
<a class="tile" id="yellow" href="#4"><div class="shape" style="background:#f2c200;border-radius:0"></div></a>
<a class="tile" id="black" href="#5"><div class="shape" style="background:#111"></div></a>
<a class="tile" id="purple" href="#6"><div class="shape" style="background:#7a2bc4;border-radius:30%"></div></a>
</main></body></html>`;

export const VISION_TARGETS: Array<[string, string]> = [
  ['the red item', 'red'],
  ['the blue item', 'blue'],
  ['the green square item', 'green'],
  ['the purple item', 'purple'],
  ['the shopping cart icon', 'cart'],
  ['the search (magnifying glass) icon', 'search'],
  ['the heart icon', 'heart'],
];

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

type Box = { x: number; y: number; width: number; height: number };
const iou = (a: Box, b: Box) => {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = w > 0 && h > 0 ? w * h : 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
};

export async function visionBench(settings: Settings, transport: ModelTransport, runs: number) {
  const width = 1008;
  const height = 756;
  const browser = await chromium.launch({
    ...(process.env['TM_CHROMIUM'] ? { executablePath: process.env['TM_CHROMIUM'] } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(VISION_PAGE);
    const truth: Record<string, Box> = {};
    for (const [, id] of VISION_TARGETS) {
      const b = await page.locator(`#${id}`).boundingBox();
      if (b) truth[id] = b;
    }
    const png = await page.screenshot({ type: 'png' });
    const image = {
      base64: png.toString('base64'),
      width,
      height,
      redacted: true as const,
      regions: 0,
    };
    const ai = createIntelligence({ settings, transport });
    const latencies: number[] = [];
    let first: number | null = null;
    let hits = 0;
    let answered = 0;
    let iouSum = 0;
    const misses: string[] = [];
    for (let run = 0; run < runs; run++) {
      for (const [target, id] of VISION_TARGETS) {
        const r = await ai.locate!({ taskId: `task-bench-${run}`, target, intent: INTENT, image });
        if (first === null) first = r.usage.latencyMs;
        else latencies.push(r.usage.latencyMs);
        if (!r.value?.found) {
          if (run === 0) misses.push(`${target}: ${r.usage.outcome} ${r.usage.reason ?? ''}`);
          continue;
        }
        answered += 1;
        const [x1, y1, x2, y2] = r.value.box;
        const box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
        const t = truth[id]!;
        const cx = x1 + box.width / 2;
        const cy = y1 + box.height / 2;
        const hit = cx >= t.x && cx <= t.x + t.width && cy >= t.y && cy <= t.y + t.height;
        if (hit) hits += 1;
        else if (run === 0) misses.push(`${target}: box ${r.value.box.map(Math.round).join(',')}`);
        iouSum += iou(box, t);
      }
    }
    const total = VISION_TARGETS.length * runs;
    const sorted = [...latencies].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted.length ? Math.round(sorted[Math.floor(p * (sorted.length - 1))]!) : null;
    let memory: unknown = null;
    try {
      memory = (
        await transport.send({
          url: `${settings.model.ollama.baseUrl}/api/ps`,
          method: 'GET',
          request: null,
          timeoutMs: 3000,
        })
      ).json;
    } catch {
      memory = 'unavailable';
    }
    return {
      model: settings.model.ollama.model,
      image: `${width}×${height}`,
      targets: VISION_TARGETS.length,
      calls: total,
      answeredRate: answered / total,
      localizationAccuracy: hits / total,
      meanIoU: answered ? iouSum / answered : 0,
      coldMs: first,
      warmP50Ms: q(0.5),
      warmP95Ms: q(0.95),
      ollamaPs: memory,
      misses,
    };
  } finally {
    await browser.close();
  }
}
