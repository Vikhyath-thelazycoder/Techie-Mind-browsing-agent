import { DEFAULT_SETTINGS, type Settings } from '@techie-mind/config';
import {
  Task,
  TaskResult,
  type AuditEvent,
  type ExtractedItem,
  type SkillId,
  type UserProfile,
} from '@techie-mind/contracts';
import type { Intelligence } from '@techie-mind/models';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { expect } from 'vitest';
import { runTask } from '../src/runner.js';
import { node, WorkflowSite, type PageDef } from './workflow-site.js';

/** Shared Phase 5/6 test website: a shop with search, priced results, products, cart, form, news. */
const header = [
  node({
    nodeId: 'q',
    tag: 'input',
    role: 'searchbox',
    name: 'Search for products',
    inputType: 'search',
    editable: true,
    attributes: { 'tm:form-role': 'search' },
    bbox: { x: 300, y: 20, width: 500, height: 36 },
  }),
  node({
    nodeId: 'cart',
    tag: 'a',
    name: `Cart`,
    attributes: { href: '/cart' },
    bbox: { x: 1100, y: 20, width: 60, height: 36 },
  }),
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
        node({
          nodeId: it.elementId,
          tag: 'a',
          name: it.title,
          attributes: { href: `/p/${i + 1}` },
          bbox: { x: 100, y: 120 + i * 120, width: 700, height: 100 },
        }),
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
      paragraphs: [
        `${name} with a full HD display, now at ₹${price.toLocaleString('en-IN')}. Free delivery in three days.`,
      ],
      tables: [],
      truncated: false,
    },
    searchField: 'q',
    nodes: [
      ...header.map((h) => (h.nodeId === 'cart' ? { ...h, name: 'Cart' } : h)),
      node({
        nodeId: 'add',
        tag: 'button',
        name: 'Add to cart',
        bbox: { x: 900, y: 400, width: 160, height: 44 },
      }),
      node({
        nodeId: 'buy',
        tag: 'button',
        name: 'Buy now',
        bbox: { x: 1080, y: 400, width: 160, height: 44 },
      }),
    ],
    clicks: {
      add: (site) => {
        site.cartCount += 1;
        const cart = site.pages[`/p/${n}`] as PageDef;
        cart.nodes = cart.nodes.map((x) =>
          x.nodeId === 'cart' ? { ...x, name: `Cart ${site.cartCount}` } : x,
        );
      },
      cart: '/cart',
    },
  };
}

const CART: PageDef = {
  title: 'Your cart - Shop',
  nodes: [
    node({ nodeId: 'h', tag: 'h1', role: 'heading', name: 'Shopping cart', interactive: false }),
    node({
      nodeId: 'pay',
      tag: 'button',
      name: 'Proceed to checkout',
      bbox: { x: 900, y: 500, width: 220, height: 44 },
    }),
  ],
  clicks: { pay: '/checkout/payment' },
};

const FORM: PageDef = {
  title: 'Delivery address - Shop',
  nodes: [
    node({
      nodeId: 'f-name',
      tag: 'input',
      role: 'textbox',
      name: 'Full name',
      inputType: 'text',
      editable: true,
      attributes: { autocomplete: 'name' },
      bbox: { x: 100, y: 100, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-email',
      tag: 'input',
      role: 'textbox',
      name: 'Email',
      inputType: 'email',
      editable: true,
      attributes: { autocomplete: 'email' },
      bbox: { x: 100, y: 150, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-phone',
      tag: 'input',
      role: 'textbox',
      name: 'Mobile number',
      inputType: 'tel',
      editable: true,
      bbox: { x: 100, y: 200, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-addr',
      tag: 'input',
      role: 'textbox',
      name: 'Address',
      inputType: 'text',
      editable: true,
      bbox: { x: 100, y: 250, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-city',
      tag: 'input',
      role: 'textbox',
      name: 'City',
      inputType: 'text',
      editable: true,
      bbox: { x: 100, y: 300, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-state',
      tag: 'select',
      role: 'combobox',
      name: 'State',
      editable: false,
      bbox: { x: 100, y: 350, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-pin',
      tag: 'input',
      role: 'textbox',
      name: 'PIN code',
      inputType: 'text',
      editable: true,
      bbox: { x: 100, y: 400, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-company',
      tag: 'input',
      role: 'textbox',
      name: 'Company',
      inputType: 'text',
      editable: true,
      bbox: { x: 100, y: 450, width: 400, height: 36 },
    }),
    node({
      nodeId: 'f-pass',
      tag: 'input',
      role: 'textbox',
      name: 'Password',
      inputType: 'password',
      editable: true,
      bbox: { x: 100, y: 500, width: 400, height: 36 },
    }),
    node({
      nodeId: 'submit',
      tag: 'button',
      name: 'Save address',
      bbox: { x: 100, y: 560, width: 160, height: 40 },
    }),
  ],
};

const ARTICLE: PageDef = {
  title: 'Monsoon arrives in Kerala',
  nodes: [
    node({
      nodeId: 'h1',
      tag: 'h1',
      role: 'heading',
      name: 'Monsoon arrives in Kerala',
      interactive: false,
    }),
  ],
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

export function shop(
  start = '/search?q=laptops',
  profile: UserProfile | null = PROFILE,
  options = {},
  origin = 'https://shop.fixture.test',
) {
  return new WorkflowSite(
    origin,
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

export async function run(
  site: WorkflowSite,
  text: string,
  extra: {
    settings?: Settings;
    intelligence?: Intelligence;
    skillInstructions?: Partial<Record<SkillId, string>>;
  } = {},
) {
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
    ...(extra.skillInstructions ? { skillInstructions: extra.skillInstructions } : {}),
  });
  expect(TaskResult.safeParse(result).success).toBe(true);
  return { result, events: sink.events as AuditEvent[] };
}
