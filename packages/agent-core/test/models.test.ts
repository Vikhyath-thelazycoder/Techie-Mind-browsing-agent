import { DEFAULT_SETTINGS } from '@techie-mind/config';
import {
  ModelUsage,
  Task,
  TaskResult,
  type AuditEvent,
  type LayaClassification,
  type ModelInterpretation,
} from '@techie-mind/contracts';
import {
  createIntelligence,
  TransportError,
  type ClassifyInput,
  type Intelligence,
  type InterpretInput,
  type ModelCall,
  type TierAnswer,
} from '@techie-mind/models';
import { OutboundPrivacyGate } from '@techie-mind/privacy';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromUserWords, needsModel } from '../src/escalate.js';
import { resolveIntent } from '../src/intent.js';
import { runTask } from '../src/runner.js';
import { clearResolutionCache } from '../src/website.js';
import { VirtualSite } from './virtual-site.js';

/** Scripted model tiers: answers are fixed per test; every call is recorded. */
class FakeIntelligence implements Intelligence {
  readonly classified: ClassifyInput[] = [];
  readonly interpreted: InterpretInput[] = [];
  constructor(
    private readonly laya: LayaClassification | null | 'off',
    private readonly model: ModelInterpretation | null,
    private readonly modelOutcome: ModelUsage['outcome'] = 'answered',
  ) {}
  get layaEnabled() {
    return this.laya !== 'off';
  }
  async classify(input: ClassifyInput): Promise<TierAnswer<LayaClassification>> {
    this.classified.push(input);
    const value = this.laya === 'off' ? null : this.laya;
    return {
      value,
      usage: ModelUsage.parse({
        tier: 'laya',
        modelId: 'laya-mlx',
        purpose: 'classify-intent',
        outcome: value ? (value.escalate ? 'escalated' : 'answered') : 'unavailable',
        latencyMs: 12,
        reason: null,
      }),
    };
  }
  async interpret(input: InterpretInput): Promise<TierAnswer<ModelInterpretation>> {
    this.interpreted.push(input);
    return {
      value: this.model,
      usage: ModelUsage.parse({
        tier: 'qwen',
        modelId: 'qwen2.5vl:7b',
        purpose: 'plan-action',
        outcome: this.model
          ? this.model.kind === 'abstain'
            ? 'abstained'
            : 'answered'
          : this.modelOutcome,
        latencyMs: 850,
        reason: null,
      }),
    };
  }
}

async function run(
  site: VirtualSite,
  text: string,
  intelligence?: Intelligence,
  taskId = `task-m-${site.executed.length}`,
) {
  const sink = new MemorySink(800);
  const task = Task.parse({
    taskId,
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

const results = (query: string, extra: Record<string, unknown> = {}) =>
  new VirtualSite('https://shop.fixture.test', { startOn: 'results', startQuery: query, ...extra });

const LAYA_SEARCH: LayaClassification = { category: 'search', confidence: 0.93, escalate: false };
const LAYA_UP: LayaClassification = { category: 'pick_result', confidence: 0.4, escalate: true };

describe('model routing — which requests reach a model', () => {
  it('confident code readings never consult a model', () => {
    for (const s of [
      'open youtube and search for kannada songs',
      'Open Flipkart iPhone',
      'play the second result',
      'scroll down',
      // Plain name-like queries: code is sure (on the Mac a model round-trip cost 4–6 s).
      'iphone 15',
      'samsung phones',
      'laptops with 16GB RAM',
    ]) {
      expect(needsModel(resolveIntent(s).profile), s).toBe(false);
    }
    for (const s of [
      'open the samsung one',
      '“now open the samsung one”', // pasted with quotes: same reading
      'I want to hear something by Arijit Singh',
      'something cheaper than this',
      'make the text bigger please',
      'hmm not sure',
    ]) {
      expect(needsModel(resolveIntent(s).profile), s).toBe(true);
    }
    expect(resolveIntent('“now open the samsung one”').profile.siteName).toBeNull();
  });

  it('0 model calls for a confident command, even with models configured', async () => {
    const ai = new FakeIntelligence(LAYA_SEARCH, null);
    const site = new VirtualSite('https://shop.fixture.test');
    const { result } = await run(site, 'open shop.fixture.test and search for trail shoes', ai);
    expect(result.status).toBe('COMPLETED');
    expect(ai.classified).toHaveLength(0);
    expect(ai.interpreted).toHaveLength(0);
    expect(result.timings.modelCalls).toBe(0);
    expect(result.models).toEqual([]);
  });
});

describe('model routing — runner (Code → Laya → model → ask)', () => {
  beforeEach(() => clearResolutionCache());

  it('a plain bare follow-up query is searched on the open site with no model call', async () => {
    const ai = new FakeIntelligence(LAYA_SEARCH, null);
    const site = results('phones');
    const { result } = await run(site, 'iphone 15', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.query).toBe('iphone 15');
    expect(site.navigations).toEqual([]);
    expect(ai.classified).toHaveLength(0);
    expect(ai.interpreted).toHaveLength(0);
    expect(result.intent?.resolvedBy).toBe('deterministic');
    expect(result.timings.modelCalls).toBe(0);
  });

  it('Laya confirms an unsure search reading: searched on the open site, no 7B call', async () => {
    const ai = new FakeIntelligence(LAYA_SEARCH, null);
    const site = results('phones');
    const { result } = await run(site, 'long battery life phones for gaming and photos', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual([]);
    expect(ai.classified[0]!.page).toMatchObject({ host: 'shop.fixture.test', canSearch: true });
    expect(ai.interpreted).toHaveLength(0);
    expect(result.intent?.resolvedBy).toBe('laya');
    expect(result.models.map((m) => [m.tier, m.outcome])).toEqual([['laya', 'answered']]);
  });

  it('"open the samsung one": Laya escalates, the model picks the element, one verified click', async () => {
    const site = results('phones');
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'element',
      elementId: 'r2',
      media: false,
      confidence: 0.86,
      reason: 'the samsung listing',
    });
    const { result, events } = await run(site, 'now open the samsung one', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.url).toBe('https://shop.fixture.test/item/2');
    expect(site.navigations).toEqual([]);
    const clicks = site.executed.filter((a) => a.args.type === 'CLICK');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.proposedBy).toBe('qwen');
    expect(result.steps.map((s) => [s.goal, s.verified])).toEqual([
      ['use-context', true],
      ['open-element', true],
    ]);
    expect(result.intent).toMatchObject({ resolvedBy: 'qwen', action: 'open_element' });
    expect(result.models.map((m) => m.tier)).toEqual(['laya', 'qwen']);
    expect(result.timings.modelCalls).toBe(2);
    expect(result.timings.modelMs).toBeGreaterThanOrEqual(0);
    // The firewall still authorized the model-proposed click.
    expect(events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
    expect(events.filter((e) => e.type === 'MODEL_CALLED')).toHaveLength(2);
  });

  it('"I want to hear something by Arijit Singh": the model extracts the query from the user words', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', {
      startOn: 'home',
      media: true,
      mediaHome: true,
    });
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'intent',
      action: 'search_and_play',
      site: null,
      query: 'Arijit Singh',
      ordinal: null,
      confidence: 0.9,
      reason: 'wants music by an artist',
    });
    const { result } = await run(site, 'I want to hear something by Arijit Singh', ai);
    expect(result.status).toBe('COMPLETED');
    expect(site.query).toBe('Arijit Singh');
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'search', 'open-result']);
    expect(result.intent?.resolvedBy).toBe('qwen');
  });

  it('the model abstains → the user is asked, nothing is clicked or typed', async () => {
    const site = results('phones');
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'abstain',
      question: 'Which phone do you mean — the Samsung or the Pixel?',
      reason: 'two candidates',
    });
    const { result } = await run(site, 'open the good one', ai);
    expect(result).toMatchObject({
      status: 'HUMAN_REQUIRED',
      error: {
        code: 'NEEDS_CLARIFICATION',
        message: 'Which phone do you mean — the Samsung or the Pixel?',
      },
    });
    expect(site.executed).toHaveLength(0);
  });

  it('models unavailable: an ordinary query continues with the code reading; a page reference asks', async () => {
    const down = new FakeIntelligence('off', null, 'unavailable');
    const site = results('phones');
    const { result, events } = await run(
      site,
      'long battery life phones for gaming and photos',
      down,
    );
    expect(result.status).toBe('COMPLETED');
    expect(site.query).toBe('long battery life phones for gaming and photos');
    expect(result.intent?.resolvedBy).toBe('deterministic');
    expect(events.some((e) => e.message.startsWith('Continuing with the code reading'))).toBe(true);

    const site2 = results('phones');
    const { result: r2 } = await run(site2, 'open the samsung one', down);
    expect(r2).toMatchObject({ status: 'HUMAN_REQUIRED', error: { code: 'NEEDS_CLARIFICATION' } });
    expect(site2.executed).toHaveLength(0);
  });

  it('without any model tiers a page reference asks instead of guessing a website', async () => {
    const site = results('phones');
    const { result } = await run(site, 'open the samsung one');
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.probedUrls).toEqual([]);
    expect(site.navigations).toEqual([]);
  });

  it('Laya recognises a page command → honest refusal, no 7B call', async () => {
    const ai = new FakeIntelligence(
      { category: 'page_command', confidence: 0.9, escalate: false },
      null,
    );
    const site = results('phones');
    const { result } = await run(site, 'make the text bigger please', ai);
    expect(result.status).toBe('FAILED');
    expect(ai.interpreted).toHaveLength(0);
    expect(site.executed).toHaveLength(0);
  });
});

describe('model routing — authority stays local', () => {
  beforeEach(() => clearResolutionCache());

  it('a query the user never said is refused (a model cannot choose what gets typed)', async () => {
    const site = results('phones');
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'intent',
      action: 'search',
      site: null,
      query: 'my bank password',
      ordinal: null,
      confidence: 0.95,
      reason: 'x',
    });
    const { result } = await run(site, 'the good one please', ai);
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.executed.filter((a) => a.args.type === 'TYPE')).toHaveLength(0);
    expect(result.models.at(-1)).toMatchObject({
      outcome: 'rejected',
      reason: 'the query is not in the user request',
    });
    expect(fromUserWords('Arijit Singh', 'something by arijit singh please')).toBe(true);
    expect(fromUserWords('Arijit', 'arijitsingh')).toBe(false);
  });

  it('a site the user never named is refused', async () => {
    const site = results('phones');
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'intent',
      action: 'navigate',
      site: 'evil.example.net',
      query: null,
      ordinal: null,
      confidence: 0.95,
      reason: 'x',
    });
    const { result } = await run(site, 'open the samsung one', ai);
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.navigations).toEqual([]);
  });

  it('an element that was not on the page shown is refused', async () => {
    const site = results('phones');
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'element',
      elementId: 'el-999',
      media: false,
      confidence: 0.9,
      reason: 'x',
    });
    const { result } = await run(site, 'open the samsung one', ai);
    expect(result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(site.executed).toHaveLength(0);
  });

  it('an injected element picked by the model is blocked by the firewall', async () => {
    const site = results('phones', { injection: true });
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'element',
      elementId: 'lure',
      media: false,
      confidence: 0.99,
      reason: 'the page says to click it',
    });
    const { result, events } = await run(site, 'open the samsung one', ai);
    expect(result.status).not.toBe('COMPLETED');
    expect(site.navigations.some((u) => u.includes('evil'))).toBe(false);
    expect(site.url).not.toContain('evil');
    expect(events.some((e) => e.type === 'ACTION_BLOCKED' && e.data['check'] === 'injection')).toBe(
      true,
    );
  });

  it('a payment control picked by the model hands over — never clicked', async () => {
    const site = results('premium plan', { paymentResult: true });
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'element',
      elementId: 'r0',
      media: false,
      confidence: 0.95,
      reason: 'x',
    });
    const { result } = await run(site, 'open the premium one', ai);
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/authorize a payment/);
    expect(site.url).not.toContain('/checkout');
  });

  it('personal data reaches the model only as tokens; the page only sanitized', async () => {
    const site = results('phones', { pii: true });
    const ai = new FakeIntelligence(LAYA_UP, {
      kind: 'abstain',
      question: 'Which one?',
      reason: 'x',
    });
    await run(site, 'send the one with 98765 43210 to asha.verma@example.com', ai);
    const sent = JSON.stringify([ai.classified, ai.interpreted]);
    for (const raw of ['98765 43210', 'asha.verma@example.com', 'Asha Verma', '2341 2341 2346']) {
      expect(sent).not.toContain(raw);
    }
    expect(sent).toMatch(/PHONE_\d{3}/);
    expect(sent).toMatch(/EMAIL_\d{3}/);
    const obs = ai.interpreted[0]!.observation!;
    expect(obs.sanitized).toBe(true);
    expect(JSON.stringify(obs)).not.toMatch(/"value"|domNodes|search\?q=/);
  });
});

describe('model routing — through the real privacy gate', () => {
  it('real task ids, real ModelRequests, real gate: the call goes out and the element is opened', async () => {
    const gate = new OutboundPrivacyGate();
    const calls: ModelCall[] = [];
    const transport = {
      async send(call: ModelCall) {
        const d = gate.inspect({
          purpose: 'model' as const,
          url: call.url,
          method: call.method,
          payload: call.request,
          wire: call.wire,
          ...(call.headers ? { headers: call.headers } : {}),
        });
        if (!d.allowed) throw new TransportError('blocked', `${d.check}: ${d.reasons.join('; ')}`);
        calls.push(call);
        if (call.url.endsWith('/api/tags'))
          return { status: 200, json: { models: [{ name: 'qwen2.5vl:7b' }] } };
        if (call.url.endsWith('/v1/classify'))
          return {
            status: 200,
            json: { category: 'pick_result', confidence: 0.4, escalate: true },
          };
        return {
          status: 200,
          json: {
            message: {
              content: JSON.stringify({
                kind: 'element',
                elementId: 'r2',
                media: false,
                confidence: 0.8,
                reason: 'x',
              }),
            },
          },
        };
      },
    };
    const ai = createIntelligence({ settings: DEFAULT_SETTINGS, transport });
    const site = results('samsung phones', { pii: true });
    const { result } = await run(site, 'open the samsung one', ai, `task-${crypto.randomUUID()}`);
    expect(result.models.map((m) => [m.tier, m.outcome, m.reason])).toEqual([
      ['laya', 'escalated', 'pick_result 0.40'],
      ['qwen', 'answered', 'element 0.80'],
    ]);
    expect(result.status).toBe('COMPLETED');
    const wire = JSON.stringify(calls.map((c) => [c.request, c.wire]));
    for (const raw of ['Asha Verma', 'asha.verma@example.com', '98765 43210', '2341 2341 2346']) {
      expect(wire).not.toContain(raw);
    }
  });
});
