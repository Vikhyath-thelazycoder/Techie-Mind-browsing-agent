import { DEFAULT_SETTINGS, type Settings } from '@techie-mind/config';
import {
  ModelUsage,
  Task,
  TaskResult,
  type AuditEvent,
  type ExtractedItem,
  type UserProfile,
} from '@techie-mind/contracts';
import type { Intelligence, SummarizeInput } from '@techie-mind/models';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { describe, expect, it } from 'vitest';
import { runTask } from '../src/runner.js';
import { node, WorkflowSite, type PageDef } from './workflow-site.js';

const header = [
  node({ nodeId: 'q', tag: 'input', role: 'searchbox', name: 'Search for products', inputType: 'search', editable: true, attributes: { 'tm:form-role': 'search' }, bbox: { x: 300, y: 20, width: 500, height: 36 } }),
  node({ nodeId: 'cart', tag: 'a', name: `Cart`, attributes: { href: '/cart' }, bbox: { x: 1100, y: 20, width: 60, height: 36 } }),
];

const PRICES: Array<[string, number]> = [
  ['Dell Inspiron 15 laptop', 58990],
  ['HP 255 G9 laptop', 34990],
  ['Lenovo IdeaPad Slim 3 laptop', 45490],
  ['ASUS Vivobook 16 laptop', 52990],
];

export function results(q: string): PageDef {
  const items: ExtractedItem[] = PRICES.map(([title, price], i) => ({
    elementId: `p${i + 1}`,
    title,
    price,
    currency: 'INR',
    rating: [4.1, 3.9, 4.4, 4.0][i]!,
    position: i + 1,
  }));
  return {
    title: `${q} - Shop`,
    searchField: 'q',
    height: 3000,
    nodes: [
      ...header,
      ...items.map((it, i) =>
        node({ nodeId: it.elementId, tag: 'a', name: it.title, attributes: { href: `/p/${i + 1}` }, bbox: { x: 100, y: 120 + i * 120, width: 700, height: 100 } }),
      ),
    ],
    items,
    clicks: Object.fromEntries(items.map((it, i) => [it.elementId, `/p/${i + 1}`])),
  };
}

export function product(n: number): PageDef {
  const [name, price] = PRICES[n - 1] ?? PRICES[0]!;
  return {
    title: `Product ${n} - Shop`,
    text: {
      title: `${name} - Shop`,
      headings: [name],
      paragraphs: [`${name} with a full HD display, now at ₹${price.toLocaleString('en-IN')}. Free delivery in three days.`],
      tables: [],
      truncated: false,
    },
    searchField: 'q',
    nodes: [
      ...header.map((h) => (h.nodeId === 'cart' ? { ...h, name: 'Cart' } : h)),
      node({ nodeId: 'add', tag: 'button', name: 'Add to cart', bbox: { x: 900, y: 400, width: 160, height: 44 } }),
      node({ nodeId: 'buy', tag: 'button', name: 'Buy now', bbox: { x: 1080, y: 400, width: 160, height: 44 } }),
    ],
    clicks: {
      add: (site) => {
        site.cartCount += 1;
        const cart = site.pages[`/p/${n}`] as PageDef;
        cart.nodes = cart.nodes.map((x) => (x.nodeId === 'cart' ? { ...x, name: `Cart ${site.cartCount}` } : x));
      },
      cart: '/cart',
    },
  };
}

const CART: PageDef = {
  title: 'Your cart - Shop',
  nodes: [
    node({ nodeId: 'h', tag: 'h1', role: 'heading', name: 'Shopping cart', interactive: false }),
    node({ nodeId: 'pay', tag: 'button', name: 'Proceed to checkout', bbox: { x: 900, y: 500, width: 220, height: 44 } }),
  ],
  clicks: { pay: '/checkout/payment' },
};

const FORM: PageDef = {
  title: 'Delivery address - Shop',
  nodes: [
    node({ nodeId: 'f-name', tag: 'input', role: 'textbox', name: 'Full name', inputType: 'text', editable: true, attributes: { autocomplete: 'name' }, bbox: { x: 100, y: 100, width: 400, height: 36 } }),
    node({ nodeId: 'f-email', tag: 'input', role: 'textbox', name: 'Email', inputType: 'email', editable: true, attributes: { autocomplete: 'email' }, bbox: { x: 100, y: 150, width: 400, height: 36 } }),
    node({ nodeId: 'f-phone', tag: 'input', role: 'textbox', name: 'Mobile number', inputType: 'tel', editable: true, bbox: { x: 100, y: 200, width: 400, height: 36 } }),
    node({ nodeId: 'f-addr', tag: 'input', role: 'textbox', name: 'Address', inputType: 'text', editable: true, bbox: { x: 100, y: 250, width: 400, height: 36 } }),
    node({ nodeId: 'f-city', tag: 'input', role: 'textbox', name: 'City', inputType: 'text', editable: true, bbox: { x: 100, y: 300, width: 400, height: 36 } }),
    node({ nodeId: 'f-state', tag: 'select', role: 'combobox', name: 'State', editable: false, bbox: { x: 100, y: 350, width: 400, height: 36 } }),
    node({ nodeId: 'f-pin', tag: 'input', role: 'textbox', name: 'PIN code', inputType: 'text', editable: true, bbox: { x: 100, y: 400, width: 400, height: 36 } }),
    node({ nodeId: 'f-company', tag: 'input', role: 'textbox', name: 'Company', inputType: 'text', editable: true, bbox: { x: 100, y: 450, width: 400, height: 36 } }),
    node({ nodeId: 'f-pass', tag: 'input', role: 'textbox', name: 'Password', inputType: 'password', editable: true, bbox: { x: 100, y: 500, width: 400, height: 36 } }),
    node({ nodeId: 'submit', tag: 'button', name: 'Save address', bbox: { x: 100, y: 560, width: 160, height: 40 } }),
  ],
};

const ARTICLE: PageDef = {
  title: 'Monsoon arrives in Kerala',
  nodes: [node({ nodeId: 'h1', tag: 'h1', role: 'heading', name: 'Monsoon arrives in Kerala', interactive: false })],
  text: {
    title: 'Monsoon arrives in Kerala',
    headings: ['Monsoon arrives in Kerala'],
    paragraphs: [
      'The south-west monsoon reached the Kerala coast on Thursday, three days ahead of the usual date. Forecasters expect normal rainfall.',
      'Farmers welcomed the early onset, which helps the sowing of kharif crops across the southern states.',
      'For updates, readers can write to the desk at asha.verma@example.com or call 98765 43210.',
    ],
    tables: [],
    truncated: false,
  },
};

export const PROFILE: UserProfile = {
  fullName: 'Asha Verma',
  email: 'asha.verma@example.com',
  phone: '98765 43210',
  addressLine1: '12 MG Road',
  addressLine2: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  country: 'India',
};

export function shop(start = '/search?q=laptops', profile: UserProfile | null = PROFILE, options = {}) {
  return new WorkflowSite(
    'https://shop.fixture.test',
    {
      '/': { title: 'Shop', searchField: 'q', nodes: header },
      '/search': results,
      '/p/1': product(1),
      '/p/2': product(2),
      '/p/3': product(3),
      '/p/4': product(4),
      '/cart': CART,
      '/checkout/payment': { title: 'Payment', nodes: [] },
      '/address': FORM,
      '/news': ARTICLE,
    },
    start,
    profile,
    options,
  );
}

export async function run(site: WorkflowSite, text: string, extra: { settings?: Settings; intelligence?: Intelligence } = {}) {
  const sink = new MemorySink(1000);
  const settings = extra.settings ?? DEFAULT_SETTINGS;
  const task = Task.parse({
    taskId: `task-w-${site.executed.length}`,
    text,
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'unknown',
    status: 'RUNNING',
    createdAt: 0,
    maxSteps: settings.agent.maxSteps,
    skillId: null,
  });
  const result = await runTask(task, {
    host: site,
    logger: createLogger({ component: 'agent', sinks: [sink], level: 'debug' }),
    settings,
    ...(extra.intelligence ? { intelligence: extra.intelligence } : {}),
  });
  expect(TaskResult.safeParse(result).success).toBe(true);
  return { result, events: sink.events as AuditEvent[] };
}

describe('Phase 5 — extraction and constraints', () => {
  it('"search for laptops under ₹50,000" on the open shop: search, read, keep what fits', async () => {
    const site = shop('/');
    const { result } = await run(site, 'search for laptops under ₹50,000');
    expect(result.status).toBe('COMPLETED');
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'search', 'extract']);
    expect(result.output?.kind).toBe('items');
    if (result.output?.kind !== 'items') throw new Error('no items');
    expect(result.output.total).toBe(4);
    expect(result.output.items.map((i) => i.price)).toEqual([34990, 45490]);
    expect(result.output.items[0]?.url).toBe('https://shop.fixture.test/p/2');
    expect(result.timings.modelCalls).toBe(0);
  });

  it('"open the cheapest one" opens the cheapest item — no model, one click', async () => {
    const site = shop();
    const { result } = await run(site, 'now open the cheapest one');
    expect(result.status).toBe('COMPLETED');
    expect(site.path).toBe('/p/2');
    expect(site.executed.filter((e) => e.action.args.type === 'CLICK')).toHaveLength(1);
    expect(result.timings.modelCalls).toBe(0);
    const s2 = shop();
    await run(s2, 'show me the most expensive');
    expect(s2.path).toBe('/p/1');
    const s3 = shop();
    await run(s3, 'open the top rated one');
    expect(s3.path).toBe('/p/3');
  });
});

describe('Phase 5 — page commands', () => {
  it('"scroll down" scrolls and verifies; at the bottom it says so', async () => {
    const site = shop();
    const { result } = await run(site, 'scroll down');
    expect(result.status).toBe('COMPLETED');
    expect(site.scrollY).toBe(640);
    site.scrollY = 2200;
    const { result: end } = await run(site, 'scroll down');
    expect(end.status).not.toBe('COMPLETED');
    expect(end.steps.at(-1)?.evidence).toMatch(/already at the bottom/);
  });

  it('"go back" / "go forward" move through history, verified', async () => {
    const site = shop();
    site.go('/p/1');
    const { result } = await run(site, 'go back');
    expect(result.status).toBe('COMPLETED');
    expect(site.path).toBe('/search?q=laptops');
    await run(site, 'go forward');
    expect(site.path).toBe('/p/1');
  });
});

describe('Phase 5 — ecommerce stops before payment', () => {
  it('"add it to cart" clicks Add to cart (not Buy now) and verifies the cart grew', async () => {
    const site = shop('/p/1');
    const { result } = await run(site, 'add it to cart');
    expect(result.status).toBe('COMPLETED');
    expect(site.cartCount).toBe(1);
    const click = site.executed.find((e) => e.action.args.type === 'CLICK')!;
    expect(click.action.binding.target).toMatchObject({ elementId: 'add' });
    expect(result.steps.at(-1)?.evidence).toMatch(/cart count 0 → 1/);
  });

  it('"go to checkout" opens the cart; on the cart, the checkout button is handed over', async () => {
    const site = shop('/p/1');
    const { result } = await run(site, 'go to checkout');
    expect(result.status).toBe('COMPLETED');
    expect(site.path).toBe('/cart');
    expect(result.steps.at(-1)?.evidence).toMatch(/payment is always yours/);
    const { result: pay } = await run(site, 'proceed to checkout');
    expect(pay.status).toBe('HUMAN_REQUIRED');
    expect(pay.error?.message).toMatch(/payment/i);
    expect(site.path).toBe('/cart');
  });
});

describe('Phase 5 — forms from the encrypted profile', () => {
  it('"fill my delivery address": fields by meaning, typed via vault tokens, verified, not submitted', async () => {
    const site = shop('/address');
    const { result, events } = await run(site, 'fill my delivery address');
    expect(result.status).toBe('COMPLETED');
    expect(site.values.get('f-name')).toBe('Asha Verma');
    expect(site.values.get('f-email')).toBe('asha.verma@example.com');
    expect(site.values.get('f-phone')).toBe('98765 43210');
    expect(site.values.get('f-addr')).toBe('12 MG Road');
    expect(site.values.get('f-city')).toBe('Bengaluru');
    expect(site.values.get('f-state')).toBe('Karnataka');
    expect(site.values.get('f-pin')).toBe('560001');
    expect(site.values.has('f-company')).toBe(false);
    expect(site.values.has('f-pass')).toBe(false);
    // Never submitted.
    expect(site.executed.some((e) => e.action.binding.target?.kind === 'element' && e.action.binding.target.elementId === 'submit')).toBe(false);
    // Typed actions carry tokens, never the values; the values travel only in `resolved`.
    const typed = site.executed.filter((e) => e.action.args.type === 'TYPE');
    expect(typed.length).toBe(6);
    for (const t of typed) {
      expect(t.action.args.type === 'TYPE' && 'vaultToken' in t.action.args.input).toBe(true);
      expect(t.resolved?.text).toBeTruthy();
    }
    // No raw profile value in events, TaskResult or the output list.
    const visible = JSON.stringify([events, { ...result, output: result.output }]);
    for (const raw of ['Asha Verma', 'asha.verma@example.com', '98765 43210', '12 MG Road', '560001']) {
      expect(visible).not.toContain(raw);
    }
    expect(result.output?.kind).toBe('list');
    if (result.output?.kind === 'list') {
      expect(result.output.title).toMatch(/nothing was submitted/);
      expect(result.output.entries.join(' ')).toMatch(/Password.*never filled/);
      expect(result.output.entries.join(' ')).toMatch(/Company.*not in your profile/);
    }
  });

  it('no saved profile → the user is told where to add it; nothing typed', async () => {
    const site = shop('/address', null);
    const { result } = await run(site, 'fill this form using my saved profile');
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/Settings → Profile/);
    expect(site.executed).toHaveLength(0);
  });
});

describe('Phase 5 — summaries', () => {
  it('without a model: an extractive summary from the page itself, personal data redacted', async () => {
    const site = shop('/news');
    const { result } = await run(site, 'summarize this page');
    expect(result.status).toBe('COMPLETED');
    expect(result.output).toMatchObject({ kind: 'text', source: 'extractive' });
    if (result.output?.kind === 'text') {
      expect(result.output.text).toMatch(/monsoon reached the Kerala coast/);
      expect(result.output.text).not.toMatch(/asha\.verma@example\.com|98765 43210/);
    }
  });

  it('with the local model: it receives redacted text blocks only, and its summary is shown', async () => {
    const seen: SummarizeInput[] = [];
    const ai: Intelligence = {
      layaEnabled: false,
      classify: async () => {
        throw new Error('not used');
      },
      interpret: async () => {
        throw new Error('not used');
      },
      summarize: async (input) => {
        seen.push(input);
        return {
          value: '• The monsoon reached Kerala early.\n• Farmers welcome it.',
          usage: ModelUsage.parse({ tier: 'qwen', modelId: 'qwen2.5vl:7b', purpose: 'plan-action', outcome: 'answered', latencyMs: 900, reason: 'summary' }),
        };
      },
    };
    const site = shop('/news');
    const { result } = await run(site, "what's this page about?", { intelligence: ai });
    expect(result.output).toMatchObject({ kind: 'text', source: 'model' });
    expect(seen).toHaveLength(1);
    const sent = JSON.stringify(seen);
    expect(sent).not.toMatch(/asha\.verma@example\.com|98765 43210/);
    expect(sent).toMatch(/EMAIL_\d{3}/);
    expect(seen[0]!.page.sanitized).toBe(true);
  });
});

describe('Phase 5 — trusted media clicks', () => {
  it('"play the second result": a trusted click opens it, so playback starts and is verified', async () => {
    const site = shop('/search?q=laptops', null, { trustedInput: true, media: true });
    const { result, events } = await run(site, 'play the second result');
    expect(result.status).toBe('COMPLETED');
    expect(site.trusted).toEqual(['p2']);
    expect(events.some((e) => e.message.startsWith('Clicked with trusted browser input'))).toBe(true);
    // The firewall authorized the same CLICK before the trusted input was used.
    expect(events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
  });

  it('trusted clicks switched off: the agent opens it and asks you to press Play (as before)', async () => {
    const site = shop('/search?q=laptops', null, { trustedInput: true, media: true });
    const settings = { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, trustedMediaClicks: false } };
    const { result } = await run(site, 'play the second result', { settings });
    expect(site.trusted).toEqual([]);
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/Press Play/);
  }, 20_000);
});
