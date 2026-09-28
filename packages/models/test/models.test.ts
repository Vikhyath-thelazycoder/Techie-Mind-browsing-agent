import { DEFAULT_SETTINGS, type Settings } from '@techie-mind/config';
import { ModelRequest, SanitizedObservation, type IntentProfile } from '@techie-mind/contracts';
import { OutboundPrivacyGate } from '@techie-mind/privacy';
import { describe, expect, it } from 'vitest';
import {
  createIntelligence,
  describePage,
  hasModel,
  parseClassification,
  parseInterpretation,
  whyInvalid,
  parseLocation,
  summarizeForModel,
  TransportError,
  type ModelCall,
  type ModelReply,
  type ModelTransport,
} from '../src/index.js';

const INTENT: IntentProfile = {
  intent: 'search',
  targetDomain: null,
  directNavigation: false,
  action: 'search',
  query: 'hear something by Arijit Singh',
  constraints: [],
  entities: [],
  language: 'en',
  riskLevel: 'LOW',
  requiresConfirmation: false,
  confidence: 0.5,
  resolvedBy: 'deterministic',
  targetSource: 'SEARCH_DISCOVERY',
  navigationPolicy: 'SEARCH_AS_LAST_RESORT',
  siteName: null,
  ordinal: null,
};

function page(nodes: number): SanitizedObservation {
  return SanitizedObservation.parse({
    observationId: 'obs-1',
    version: 1,
    origin: 'https://shop.fixture.test',
    path: '/search',
    title: 'phones - results',
    createdAt: 0,
    nodes: Array.from({ length: nodes }, (_, i) => ({
      nodeId: `el-${i}`,
      role: i % 10 === 0 ? 'heading' : 'link',
      name: i === 3 ? 'Samsung Galaxy S24 (Black, 256 GB)' : `Product ${i}`,
      text: null,
      interactive: i % 10 !== 0,
      editable: false,
      bbox: { x: 0, y: i * 40, width: 300, height: 30 },
    })),
    findings: [],
    redactionCount: 0,
    sanitized: true,
  });
}

/** Stand-in transport: records calls, runs the real privacy gate, answers like the real servers. */
class StandIn implements ModelTransport {
  readonly calls: ModelCall[] = [];
  readonly gate = new OutboundPrivacyGate();
  constructor(private readonly answer: (call: ModelCall) => ModelReply | Promise<ModelReply>) {}
  async send(call: ModelCall): Promise<ModelReply> {
    const decision = this.gate.inspect({
      purpose: 'model',
      url: call.url,
      method: call.method,
      payload: call.request,
      wire: call.wire,
      ...(call.headers ? { headers: call.headers } : {}),
      ...(call.images ? { images: call.images } : {}),
    });
    if (!decision.allowed) throw new TransportError('blocked', decision.reasons.join('; '));
    this.calls.push(call);
    return this.answer(call);
  }
}

const tags = (names: string[]): ModelReply => ({
  status: 200,
  json: { models: names.map((name) => ({ name })) },
});
const chat = (content: unknown): ModelReply => ({
  status: 200,
  json: { message: { role: 'assistant', content: JSON.stringify(content) } },
});

function ollama(content: unknown, installed = ['qwen2.5vl:7b']) {
  return new StandIn((call) => (call.url.endsWith('/api/tags') ? tags(installed) : chat(content)));
}

const settings = (patch: Partial<Settings['model']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  model: { ...DEFAULT_SETTINGS.model, ...patch },
});

describe('model contracts — strict parsing', () => {
  it('accepts well-formed interpretations of each kind', () => {
    expect(
      parseInterpretation(
        '{"kind":"intent","action":"search_and_play","site":null,"query":"Arijit Singh","ordinal":null,"confidence":0.9,"reason":"wants music"}',
      ),
    ).toMatchObject({ kind: 'intent', action: 'search_and_play', query: 'Arijit Singh' });
    expect(
      parseInterpretation({
        kind: 'element',
        elementId: 'el-3',
        media: false,
        confidence: 0.8,
        reason: 'x',
      }),
    ).toMatchObject({ kind: 'element', elementId: 'el-3' });
    expect(
      parseInterpretation({ kind: 'abstain', question: 'Which song?', confidence: 0, reason: 'x' }),
    ).toMatchObject({
      kind: 'abstain',
      question: 'Which song?',
    });
  });

  it('an open/play answer that names an element is an element pick (real qwen2.5vl output)', () => {
    // Seen on the Mac: the model chose the right element but labelled the answer "intent".
    const real =
      '{\n  "kind": "intent",\n  "confidence": 0.9,\n  "reason": "the Samsung Galaxy S24",\n  "action": "open_result",\n  "elementId": "el-13",\n  "media": false\n}';
    expect(parseInterpretation(real)).toEqual({
      kind: 'element',
      elementId: 'el-13',
      media: false,
      confidence: 0.9,
      reason: 'the Samsung Galaxy S24',
    });
    expect(
      parseInterpretation({
        kind: 'intent',
        action: 'play_result',
        elementId: 'el-2',
        confidence: 0.8,
        reason: '',
      }),
    ).toMatchObject({ kind: 'element', elementId: 'el-2', media: true });
    // Without an element it stays a (positional) intent.
    expect(
      parseInterpretation({
        kind: 'intent',
        action: 'open_result',
        ordinal: 2,
        elementId: null,
        confidence: 0.8,
        reason: '',
      }),
    ).toMatchObject({ kind: 'intent', action: 'open_result', ordinal: 2 });
  });

  it('says which check an invalid answer failed, without echoing its content', () => {
    expect(whyInvalid('play Arijit Singh')).toBe('not one JSON object');
    expect(whyInvalid('{"kind":"intent","secret":"98765 43210","confidence":0.9}')).toBe(
      'unknown keys (1)',
    );
    expect(whyInvalid('{"kind":"run_js"}')).toBe('unknown kind');
    expect(
      whyInvalid('{"kind":"intent","action":"search","query":"x","confidence":1.7,"reason":""}'),
    ).toMatch(/^schema: confidence/);
    expect(
      whyInvalid('{"kind":"intent","action":"search","query":"x","confidence":1.7}'),
    ).not.toMatch(/x/);
  });

  it('rejects everything else — never repaired, never guessed', () => {
    const bad = [
      'play Arijit Singh', // prose
      '```json {"kind":"intent"} ```', // fenced
      '[{"kind":"intent"}]', // array
      '{"kind":"intent","action":"delete_account","query":"x","confidence":0.9,"reason":""}', // unknown action
      '{"kind":"intent","action":"search","query":"x","confidence":1.7,"reason":""}', // out of range
      '{"kind":"element","elementId":"el 3; drop","media":false,"confidence":0.9,"reason":""}', // bad id
      '{"kind":"intent","action":"search","query":"x","confidence":0.9,"reason":"","script":"alert(1)"}', // extra key
      '{"kind":"run_js","confidence":0.9,"reason":""}', // unknown kind
      '{"kind":"intent","action":"search","query":"' +
        'x'.repeat(300) +
        '","confidence":0.9,"reason":""}', // too long
    ];
    for (const raw of bad) expect(parseInterpretation(raw), raw.slice(0, 40)).toBeNull();
  });

  it('Laya answers are typed choices only', () => {
    expect(parseClassification({ category: 'search', confidence: 0.9, escalate: false })).toEqual({
      category: 'search',
      confidence: 0.9,
      escalate: false,
    });
    expect(
      parseClassification({ category: 'delete', confidence: 0.9, escalate: false }),
    ).toBeNull();
    expect(parseClassification({ category: 'search', confidence: 0.9 })).toBeNull();
    expect(parseClassification('not json')).toBeNull();
  });
});

describe('model page summary', () => {
  it('is a bounded SanitizedObservation with named elements only', () => {
    const summary = summarizeForModel(page(200));
    expect(SanitizedObservation.safeParse(summary).success).toBe(true);
    expect(summary.nodes.length).toBeLessThanOrEqual(60);
    expect(summary.findings).toEqual([]);
    expect(summary.nodes.map((n) => n.nodeId)).toContain('el-3');
    const text = describePage(summary);
    expect(text).toContain('el-3 | link | Samsung Galaxy S24 (Black, 256 GB)');
    expect(text).toContain('Page: https://shop.fixture.test/search');
  });
});

describe('intelligence — tiers, availability and privacy', () => {
  it('sends a gated ModelRequest to Ollama with the configured model and a JSON schema', async () => {
    const t = ollama({
      kind: 'intent',
      action: 'search_and_play',
      site: null,
      query: 'Arijit Singh',
      ordinal: null,
      confidence: 0.9,
      reason: 'music',
    });
    const ai = createIntelligence({ settings: settings(), transport: t });
    const r = await ai.interpret({
      taskId: `task-${crypto.randomUUID()}`,
      text: 'I want to hear something by Arijit Singh',
      intent: INTENT,
      observation: page(5),
    });
    expect(r.usage).toMatchObject({ tier: 'qwen', modelId: 'qwen2.5vl:7b', outcome: 'answered' });
    expect(r.value).toMatchObject({ kind: 'intent', query: 'Arijit Singh' });
    const post = t.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(ModelRequest.safeParse(post.request).success).toBe(true);
    expect(post.wire).toMatchObject({ model: 'qwen2.5vl:7b', stream: false, keep_alive: '30m' });
    expect((post.wire as { format: { type: string } }).format.type).toBe('object');
  });

  it('never substitutes another model: a missing model is "unavailable" and nothing is sent', async () => {
    const t = ollama({ kind: 'abstain', question: 'q', reason: 'r' }, ['llama3:8b', 'qwen2.5:7b']);
    const ai = createIntelligence({ settings: settings(), transport: t });
    const r = await ai.interpret({ taskId: 't1', text: 'x', intent: INTENT, observation: null });
    expect(r.value).toBeNull();
    expect(r.usage.outcome).toBe('unavailable');
    expect(r.usage.reason).toContain('qwen2.5vl:7b is not installed');
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(hasModel(['qwen2.5vl:latest'], 'qwen2.5vl')).toBe(true);
    expect(hasModel(['qwen2.5vl:7b'], 'qwen2.5:7b')).toBe(false);
  });

  it('maps failures to outcomes: offline, timeout, malformed and blocked', async () => {
    const offline = createIntelligence({
      settings: settings(),
      transport: new StandIn(() => {
        throw new TransportError('unreachable', 'connection refused');
      }),
    });
    expect(
      (await offline.interpret({ taskId: 't', text: 'x', intent: INTENT, observation: null })).usage
        .outcome,
    ).toBe('unavailable');
    const slow = createIntelligence({
      settings: settings(),
      transport: new StandIn((c) => {
        if (c.url.endsWith('/api/tags')) return tags(['qwen2.5vl:7b']);
        throw new TransportError('timeout', 'no answer in 30000 ms');
      }),
    });
    expect(
      (await slow.interpret({ taskId: 't', text: 'x', intent: INTENT, observation: null })).usage
        .outcome,
    ).toBe('timeout');
    const prose = createIntelligence({
      settings: settings(),
      transport: new StandIn((c) =>
        c.url.endsWith('/api/tags')
          ? tags(['qwen2.5vl:7b'])
          : { status: 200, json: { message: { content: 'Sure! Playing it.' } } },
      ),
    });
    expect(
      (await prose.interpret({ taskId: 't', text: 'x', intent: INTENT, observation: null })).usage
        .outcome,
    ).toBe('invalid');
    // Raw personal data in the request text never leaves: the gate blocks the call.
    const t = ollama({ kind: 'abstain', question: 'q', reason: 'r' });
    const leaky = createIntelligence({ settings: settings(), transport: t });
    const r = await leaky.interpret({
      taskId: 't',
      text: 'email asha.verma@example.com my order',
      intent: INTENT,
      observation: null,
    });
    expect(r.usage.outcome).toBe('blocked');
    expect(t.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('Laya: authenticated typed call to the local adapter; disabled means no call', async () => {
    const t = new StandIn((c) => ({
      status: c.headers?.['x-techie-mind-laya-token'] === 'tok123' ? 200 : 401,
      json: { category: 'search', confidence: 0.92, escalate: false },
    }));
    const ai = createIntelligence({
      settings: settings({
        laya: { enabled: true, adapterUrl: 'http://127.0.0.1:8765', token: 'tok123' },
      }),
      transport: t,
    });
    const r = await ai.classify({
      taskId: 't',
      text: 'iphone 15',
      intent: INTENT,
      page: { host: 'shop.fixture.test', canSearch: true, resultCount: 0 },
    });
    expect(r.value).toEqual({ category: 'search', confidence: 0.92, escalate: false });
    expect(r.usage).toMatchObject({ tier: 'laya', outcome: 'answered' });
    expect(t.calls[0]!.url).toBe('http://127.0.0.1:8765/v1/classify');
    expect(t.calls[0]!.wire).toMatchObject({
      text: 'iphone 15',
      choices: expect.arrayContaining(['search', 'pick_result']),
    });

    const wrongToken = createIntelligence({
      settings: settings({
        laya: { enabled: true, adapterUrl: 'http://127.0.0.1:8765', token: 'nope' },
      }),
      transport: t,
    });
    expect(
      (await wrongToken.classify({ taskId: 't', text: 'x', intent: INTENT, page: null })).usage
        .outcome,
    ).toBe('unavailable');

    const off = new StandIn(() => tags([]));
    const disabled = createIntelligence({
      settings: settings({
        laya: { enabled: false, adapterUrl: 'http://127.0.0.1:8765', token: '' },
      }),
      transport: off,
    });
    expect(disabled.layaEnabled).toBe(false);
    expect(
      (await disabled.classify({ taskId: 't', text: 'x', intent: INTENT, page: null })).usage
        .reason,
    ).toBe('disabled');
    expect(off.calls).toHaveLength(0);
  });

  it('the privacy gate refuses non-loopback model endpoints unless configured', () => {
    const gate = new OutboundPrivacyGate();
    expect(
      gate.inspect({ purpose: 'model', url: 'https://evil.example.net/api/tags', method: 'GET' })
        .allowed,
    ).toBe(false);
    expect(
      gate.inspect({ purpose: 'model', url: 'http://127.0.0.1:11434/api/tags', method: 'GET' })
        .allowed,
    ).toBe(true);
    expect(
      gate.inspect({
        purpose: 'model',
        url: 'http://127.0.0.1:8765/v1/classify',
        method: 'POST',
        payload: { not: 'a model request' },
      }).check,
    ).toBe('schema');
    expect(
      gate.inspect({
        purpose: 'model',
        url: 'http://127.0.0.1:11434/api/tags',
        method: 'GET',
        headers: { cookie: 'x' },
      }).allowed,
    ).toBe(false);
  });
});

const IMAGE = {
  base64: 'iVBORw0KGgoAAAANSUhEUg==',
  width: 1008,
  height: 756,
  redacted: true as const,
  regions: 2,
};

describe('vision — local visual grounding client', () => {
  it('sends the redacted image to the local model by placeholder; answers a box inside the image', async () => {
    const t = new StandIn((call) =>
      call.url.endsWith('/api/tags')
        ? tags(['qwen2.5vl:7b'])
        : chat({ found: true, box: [350, 210, 530, 390], label: 'red shoe', confidence: 0.8 }),
    );
    const ai = createIntelligence({ settings: settings(), transport: t });
    const r = await ai.locate!({
      taskId: `task-${crypto.randomUUID()}`,
      target: 'the red one',
      intent: INTENT,
      image: IMAGE,
    });
    expect(r.value).toEqual({
      found: true,
      box: [350, 210, 530, 390],
      label: 'red shoe',
      confidence: 0.8,
    });
    expect(r.usage).toMatchObject({
      tier: 'vision',
      purpose: 'visual-grounding',
      outcome: 'answered',
    });
    const post = t.calls.find((c) => c.method === 'POST')!;
    expect(post.request?.purpose).toBe('visual-grounding');
    expect(JSON.stringify(post.wire)).toContain('"images":["<image:0>"]');
    expect(JSON.stringify(post.wire)).not.toContain(IMAGE.base64);
    expect(post.images).toEqual([IMAGE]);
  });

  it('screenshots never go to a remote gateway', async () => {
    const t = new StandIn(() => chat({ found: false, reason: 'x' }));
    const ai = createIntelligence({
      settings: settings({
        activeProvider: 'openai-compatible',
        openaiCompatible: { endpoint: 'https://gw.example.com', model: 'gpt-x' },
      }),
      transport: t,
    });
    const r = await ai.locate!({ taskId: 't', target: 'x', intent: INTENT, image: IMAGE });
    expect(r.usage.outcome).toBe('unavailable');
    expect(t.calls).toHaveLength(0);
  });

  it('vision answers are strict: a box inside the image with positive area, or "not found"', () => {
    expect(
      parseLocation({ found: true, box: [10, 10, 50, 40], label: 'x', confidence: 0.7 }, 100, 100),
    ).toMatchObject({ found: true });
    expect(parseLocation({ found: false, reason: 'not there' }, 100, 100)).toEqual({
      found: false,
      reason: 'not there',
    });
    for (const bad of [
      { found: true, box: [10, 10, 5, 40], label: 'x', confidence: 0.7 }, // inverted
      { found: true, box: [10, 10, 500, 40], label: 'x', confidence: 0.7 }, // outside
      { found: true, box: [10, 10, 50], label: 'x', confidence: 0.7 }, // 3 numbers
      { found: true, box: [10, 10, 50, 40], label: 'x', confidence: 0.7, click: true }, // extra key
      { found: true, box: [-5, 10, 50, 40], label: 'x', confidence: 0.7 }, // negative
      'click at 30,40',
    ]) {
      expect(parseLocation(bad, 100, 100), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the gate: images only for visual grounding, only redacted, bounded — and never text-scanned', () => {
    const gate = new OutboundPrivacyGate();
    const req = (purpose: 'visual-grounding' | 'plan-action') =>
      ModelRequest.parse({
        requestId: 'r1',
        taskId: 't1',
        tier: 'vision',
        modelId: 'qwen2.5vl:7b',
        purpose,
        userGoal: 'the red one',
        intent: null,
        observation: null,
        createdAt: 0,
        sanitized: true,
      });
    const base = {
      purpose: 'model' as const,
      url: 'http://127.0.0.1:11434/api/chat',
      method: 'POST' as const,
    };
    // A real screenshot's base64 looks like a high-entropy secret — it must not be scanned as text.
    const big = { ...IMAGE, base64: 'A9zQ+/'.repeat(4000) + 'Kx==' };
    expect(
      gate.inspect({
        ...base,
        payload: req('visual-grounding'),
        wire: { images: ['<image:0>'] },
        images: [big],
      }).allowed,
    ).toBe(true);
    expect(gate.inspect({ ...base, payload: req('plan-action'), images: [IMAGE] }).allowed).toBe(
      false,
    );
    expect(
      gate.inspect({
        ...base,
        payload: req('visual-grounding'),
        images: [{ ...IMAGE, redacted: false as unknown as true }],
      }).check,
    ).toBe('sanitization');
    expect(
      gate.inspect({ ...base, payload: req('visual-grounding'), images: [IMAGE, IMAGE] }).allowed,
    ).toBe(false);
    expect(
      gate.inspect({
        ...base,
        payload: req('visual-grounding'),
        images: [{ ...IMAGE, base64: 'not base64!' }],
      }).allowed,
    ).toBe(false);
    // Text around the image is still scanned.
    expect(
      gate.inspect({
        ...base,
        payload: { ...req('visual-grounding'), userGoal: 'mail asha.verma@example.com' },
        images: [IMAGE],
      }).check,
    ).toBe('pii');
  });
});
