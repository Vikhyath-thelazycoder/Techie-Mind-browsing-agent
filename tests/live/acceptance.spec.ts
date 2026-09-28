import { agentPage, explain, runAgentTask, type AgentRun } from '../browser/agent-helpers.js';
import { expect, test } from '../browser/fixtures.js';
import { record, searchFieldValue, visibleMatchingLinks } from './live-helpers.js';

/**
 * Phase 1 acceptance on LIVE websites. The agent gets only the sentence. Each test then verifies
 * the real page independently: host, path, query parameter, visible search-field value and visible
 * result links. Nothing here tells the agent how any site works.
 */

interface Case {
  id: string;
  request: string;
  host: string;
  path: RegExp;
  param: string | null;
  query: string;
}

async function check(context: Parameters<typeof agentPage>[0], run: AgentRun, c: Case) {
  expect(run.result.status, explain(run)).toBe('COMPLETED');
  const page = agentPage(context, `https://www.${c.host}`);
  await page.waitForLoadState('domcontentloaded');
  const url = new URL(page.url());
  const field = await searchFieldValue(page);
  // Independent check (not the agent's): poll briefly because live sites re-render result lists.
  let links = 0;
  await expect
    .poll(async () => (links = await visibleMatchingLinks(page, c.query)), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3)
    .catch(() => undefined);
  await page.screenshot({ path: `evidence/phase1-live-${c.id}.png` });
  record({
    name: c.id,
    request: c.request,
    status: run.result.status,
    finalUrl: page.url(),
    independent: {
      host: url.hostname,
      path: url.pathname,
      param: c.param ? url.searchParams.get(c.param) : null,
      field,
      matchingLinks: links,
    },
    timings: run.result.timings,
    wallMs: run.wallMs,
    recovery: run.result.steps.flatMap((s) =>
      s.recovery.map((r) => `${s.goal}:L${r.level}:${r.strategy}`),
    ),
  });
  expect(url.hostname.endsWith(c.host), `host ${url.hostname}`).toBe(true);
  expect(url.pathname).toMatch(c.path);
  if (c.param) expect(url.searchParams.get(c.param)?.toLowerCase()).toBe(c.query.toLowerCase());
  expect(field?.toLowerCase()).toBe(c.query.toLowerCase());
  expect(links, 'visible result links matching the query').toBeGreaterThanOrEqual(3);
}

const ACCEPTANCE: Case[] = [
  {
    id: 'A',
    request: 'Open YouTube and search for Kannada songs.',
    host: 'youtube.com',
    path: /^\/results$/,
    param: 'search_query',
    query: 'Kannada songs',
  },
  {
    id: 'B',
    request: 'Open YouTube and search for Python tutorials.',
    host: 'youtube.com',
    path: /^\/results$/,
    param: 'search_query',
    query: 'Python tutorials',
  },
  {
    id: 'C',
    request: 'Open Flipkart and search for running shoes.',
    host: 'flipkart.com',
    path: /^\/search$/,
    param: 'q',
    query: 'running shoes',
  },
];

const VARIATIONS: Case[] = [
  {
    id: 'V1',
    request: 'go to youtube and look up lo-fi beats for studying',
    host: 'youtube.com',
    path: /^\/results$/,
    param: 'search_query',
    query: 'lo-fi beats for studying',
  },
  {
    id: 'V2',
    request: 'YouTube par carnatic violin search karo',
    host: 'youtube.com',
    path: /^\/results$/,
    param: 'search_query',
    query: 'carnatic violin',
  },
  {
    id: 'V3',
    request: 'Search Flipkart for steel water bottle',
    host: 'flipkart.com',
    path: /^\/search$/,
    param: 'q',
    query: 'steel water bottle',
  },
  {
    id: 'V4',
    request: 'Flipkart alli bluetooth headphones search maadu',
    host: 'flipkart.com',
    path: /^\/search$/,
    param: 'q',
    query: 'bluetooth headphones',
  },
];

test.describe('Phase 1 acceptance — live websites', () => {
  for (const c of ACCEPTANCE) {
    test(`Test ${c.id}: ${c.request}`, async ({ context, extensionId }) => {
      await check(context, await runAgentTask(context, extensionId, c.request), c);
    });
  }
});

test.describe('Phase 1 variations — live websites', () => {
  for (const c of VARIATIONS) {
    test(`${c.id}: ${c.request}`, async ({ context, extensionId }) => {
      await check(context, await runAgentTask(context, extensionId, c.request), c);
    });
  }
});
