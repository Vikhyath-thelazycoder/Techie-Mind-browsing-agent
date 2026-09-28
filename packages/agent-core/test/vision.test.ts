import { DEFAULT_SETTINGS } from '@techie-mind/config';
import {
  ModelUsage,
  Task,
  TaskResult,
  type AuditEvent,
  type LayaClassification,
  type ModelInterpretation,
  type Observation,
  type VisualLocation,
} from '@techie-mind/contracts';
import type {
  ClassifyInput,
  Intelligence,
  InterpretInput,
  LocateInput,
  TierAnswer,
} from '@techie-mind/models';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { describe, expect, it } from 'vitest';
import { runTask } from '../src/runner.js';
import {
  groundRegion,
  regionToPage,
  visionWorthTrying,
  visualOnlyElements,
} from '../src/vision.js';
import { VirtualSite } from './virtual-site.js';

const usage = (
  tier: ModelUsage['tier'],
  purpose: ModelUsage['purpose'],
  outcome: ModelUsage['outcome'],
) =>
  ModelUsage.parse({
    tier,
    modelId: tier === 'laya' ? 'laya-mlx' : 'qwen2.5vl:7b',
    purpose,
    outcome,
    latencyMs: 5,
    reason: null,
  });

/** Model tiers with a scripted vision answer; every call recorded. */
class VisionFake implements Intelligence {
  readonly located: LocateInput[] = [];
  readonly interpreted: InterpretInput[] = [];
  readonly layaEnabled = true;
  constructor(
    private readonly vision: VisualLocation | null,
    private readonly model: ModelInterpretation | null = {
      kind: 'abstain',
      question: 'Which one?',
      reason: 'no names',
    },
  ) {}
  async classify(_: ClassifyInput): Promise<TierAnswer<LayaClassification>> {
    return {
      value: { category: 'pick_result', confidence: 0.4, escalate: true },
      usage: usage('laya', 'classify-intent', 'escalated'),
    };
  }
  async interpret(input: InterpretInput): Promise<TierAnswer<ModelInterpretation>> {
    this.interpreted.push(input);
    return {
      value: this.model,
      usage: usage(
        'qwen',
        'plan-action',
        this.model?.kind === 'abstain' ? 'abstained' : 'answered',
      ),
    };
  }
  async locate(input: LocateInput): Promise<TierAnswer<VisualLocation>> {
    this.located.push(input);
    return {
      value: this.vision,
      usage: usage(
        'vision',
        'visual-grounding',
        this.vision ? (this.vision.found ? 'answered' : 'abstained') : 'unavailable',
      ),
    };
  }
}

async function run(site: VirtualSite, text: string, intelligence?: Intelligence) {
  const sink = new MemorySink(800);
  const task = Task.parse({
    taskId: `task-v-${site.executed.length}`,
    text,
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'unknown',
    status: 'RUNNING',
    createdAt: 0,
    maxSteps: DEFAULT_SETTINGS.agent.maxSteps,
    skillId: null,
  });
  const result = await runTask(task, {
    host: site,
    logger: createLogger({ component: 'agent', sinks: [sink], level: 'debug' }),
    settings: DEFAULT_SETTINGS,
    ...(intelligence ? { intelligence } : {}),
  });
  expect(TaskResult.safeParse(result).success).toBe(true);
  return { result, events: sink.events as AuditEvent[] };
}

const tiles = (extra: Record<string, unknown> = {}) =>
  new VirtualSite('https://shop.fixture.test', {
    startOn: 'results',
    startQuery: 'shoes',
    imageResults: true,
    ...extra,
  });

/** The second tile (r2: x 340–540, y 200–400) as a box in image pixels (scale 1, no scroll). */
const SECOND_TILE: VisualLocation = {
  found: true,
  box: [350, 210, 530, 390],
  label: 'red shoe',
  confidence: 0.8,
};

describe('vision — when it is worth looking', () => {
  it('only pages with visual-only elements qualify', async () => {
    const text = new VirtualSite('https://shop.fixture.test', {
      startOn: 'results',
      startQuery: 'shoes',
    });
    const img = tiles();
    const obs = (s: VirtualSite) => s.observe(1, 't', 'o') as Promise<Observation>;
    expect(visualOnlyElements(await obs(text))).toBe(0);
    expect(visionWorthTrying(await obs(text))).toBe(false);
    expect(visualOnlyElements(await obs(img))).toBeGreaterThanOrEqual(2);
    expect(visionWorthTrying(await obs(img))).toBe(true);
  });

  it('a page code can ground makes 0 vision calls and 0 captures', async () => {
    const site = new VirtualSite('https://shop.fixture.test', {
      startOn: 'results',
      startQuery: 'shoes',
    });
    const ai = new VisionFake(SECOND_TILE);
    const { result } = await run(site, 'open the second result', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.captures).toHaveLength(0);
    expect(ai.located).toHaveLength(0);
    expect(result.timings.visionMs).toBe(0);
  });

  it('a text-only page where nothing matches never triggers vision', async () => {
    const site = new VirtualSite('https://shop.fixture.test', {
      startOn: 'results',
      startQuery: 'shoes',
    });
    const ai = new VisionFake(SECOND_TILE);
    const { result } = await run(site, 'open the samsung one', ai);
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.captures).toHaveLength(0);
    expect(ai.located).toHaveLength(0);
  });
});

describe('vision — regions to elements', () => {
  it('maps image pixels to page coordinates with scale and scroll', () => {
    expect(regionToPage([100, 50, 300, 150], { scale: 0.5, scrollX: 0, scrollY: 400 })).toEqual({
      x: 200,
      y: 500,
      width: 400,
      height: 200,
    });
  });

  it('grounds a region to the best-overlapping visible interactive element, or to nothing', async () => {
    const obs = (await tiles().observe(1, 't', 'o')) as Observation;
    expect(groundRegion({ x: 350, y: 210, width: 180, height: 180 }, obs)?.node.nodeId).toBe('r2');
    expect(groundRegion({ x: 110, y: 205, width: 60, height: 60 }, obs)?.node.nodeId).toBe('r1');
    // Empty space between tiles: no element → null (never a coordinate click).
    expect(groundRegion({ x: 900, y: 600, width: 50, height: 50 }, obs)).toBeNull();
    // Non-interactive image alone is not a target.
    const imgOnly = { ...obs, domNodes: obs.domNodes.filter((n) => n.tag === 'img') };
    expect(groundRegion({ x: 360, y: 220, width: 160, height: 160 }, imgOnly)).toBeNull();
  });
});

describe('vision — runner fallback through the firewall', () => {
  it('"open the red one" on image tiles: model unsure → vision locates → one verified click', async () => {
    const site = tiles();
    const ai = new VisionFake(SECOND_TILE);
    const { result, events } = await run(site, 'open the red one', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.url).toBe('https://shop.fixture.test/item/2');
    expect(site.captures).toEqual([{ people: true }]); // face blurring on by default
    expect(ai.located).toHaveLength(1);
    expect(result.intent?.resolvedBy).toBe('vision');
    expect(result.models.map((m) => m.tier)).toEqual(['laya', 'qwen', 'vision']);
    const click = site.executed.find((a) => a.args.type === 'CLICK')!;
    expect(click.proposedBy).toBe('vision');
    expect(click.binding.target).toMatchObject({ kind: 'element', elementId: 'r2' });
    expect(events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
    expect(events.some((e) => e.message.startsWith('Screenshot redacted locally'))).toBe(true);
    expect(result.timings.visionMs).toBeGreaterThanOrEqual(0);
  });

  it('"play the second result" when results are image tiles: grounding finds none → vision', async () => {
    const site = tiles();
    const ai = new VisionFake(SECOND_TILE);
    const { result } = await run(site, 'open the second result', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.url).toBe('https://shop.fixture.test/item/2');
    expect(result.steps.at(-1)?.recovery.map((r) => r.strategy)).toContain('alternative-strategy');
  });

  it('vision says "not visible" or finds empty space → the user is asked, nothing clicked', async () => {
    for (const vision of [
      { found: false as const, reason: 'no red item' },
      {
        found: true as const,
        box: [900, 600, 950, 650] as [number, number, number, number],
        label: 'gap',
        confidence: 0.9,
      },
    ]) {
      const site = tiles();
      const { result } = await run(site, 'open the red one', new VisionFake(vision));
      expect(result.status).toBe('HUMAN_REQUIRED');
      expect(site.executed.filter((a) => a.args.type === 'CLICK')).toHaveLength(0);
    }
  });

  it('a payment control located by vision is handed over, never clicked', async () => {
    const site = tiles({ paymentResult: true, startQuery: 'premium plan' });
    // r0 = "Buy … Pay ₹499 now" at x 100–700, y 110–190
    const ai = new VisionFake({
      found: true,
      box: [110, 115, 690, 185],
      label: 'pay',
      confidence: 0.9,
    });
    const { result } = await run(site, 'open the cheap one', ai);
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/authorize a payment/);
    expect(site.url).not.toContain('/checkout');
  });

  it('an injected element located by vision is blocked by the firewall', async () => {
    const site = tiles({ injection: true });
    // lure at x 100–700, y 120–200
    const ai = new VisionFake({
      found: true,
      box: [110, 125, 690, 195],
      label: 'lure',
      confidence: 0.95,
    });
    const { result, events } = await run(site, 'open the blue one', ai);
    expect(result.status).not.toBe('COMPLETED');
    expect(site.url).not.toContain('evil');
    expect(events.some((e) => e.type === 'ACTION_BLOCKED' && e.data['check'] === 'injection')).toBe(
      true,
    );
  });

  it('what vision receives: redacted image, tokenized target — never raw personal data', async () => {
    const site = tiles({ pii: true });
    const ai = new VisionFake(SECOND_TILE);
    await run(site, 'open the one for asha.verma@example.com', ai);
    expect(ai.located).toHaveLength(1);
    const sent = JSON.stringify(ai.located);
    expect(sent).not.toContain('asha.verma@example.com');
    expect(sent).toMatch(/EMAIL_\d{3}/);
    expect(ai.located[0]!.image.redacted).toBe(true);
    expect(ai.located[0]!.image.regions).toBe(1);
  });

  it('no vision tier or no capture: hand over exactly as before', async () => {
    const site = tiles();
    const { result } = await run(site, 'open the red one');
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.captures).toHaveLength(0);
  });
});
