import type { BrowserContext, Page } from '@playwright/test';
import { driverPage, explain, runAgentTask, type AgentRun } from './agent-helpers.js';
import { expect, test } from './fixtures.js';
import {
  AMBIGUOUS_BRAND,
  BRAND,
  serveWebsiteFixtures,
  UNKNOWN_BRAND,
  type WebsiteFixtures,
} from './sites.js';

/**
 * Phase 1 correction in real Chromium: website resolution, current-tab awareness and task
 * continuity. Everything is served locally; a guard route fails the test if anything — a page or
 * the extension's own resolution fetch — tries to reach the real network. Assertions check the
 * browser's tabs independently of the agent's report.
 */
test.describe.configure({ timeout: 120_000 });

let net: WebsiteFixtures;
test.beforeEach(async ({ context }) => {
  net = await serveWebsiteFixtures(context);
});
test.afterEach(() => {
  expect(net.escaped, 'requests escaped to the real network').toEqual([]);
});

/** Open a web page in its own tab and make it the active tab (what the user is looking at). */
async function openActive(
  context: BrowserContext,
  extensionId: string,
  url: string,
): Promise<Page> {
  await driverPage(context, extensionId); // the task client exists before the user's tab
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

const navigations = (run: AgentRun) => run.events.filter((e) => e.type === 'NAVIGATION_STARTED');

test("positive control: the guard sees the service worker's own fetches", async ({
  serviceWorker,
}) => {
  await serviceWorker.evaluate(() =>
    fetch('https://unrouted-control.example/', { credentials: 'omit' }).catch(() => undefined),
  );
  expect(net.escaped).toEqual(['https://unrouted-control.example/']);
  net.escaped.length = 0;
});

test.describe('website resolution — arbitrary names, no search engine', () => {
  test('"Open <brand>" resolves the website and navigates there directly', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, `Open ${BRAND}`);
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.navigation).toMatchObject({
      targetSource: 'RESOLVED_WEBSITE',
      navigationPolicy: 'RESOLVE_WEBSITE',
      resolution: { chosen: { domain: 'kestrelmart.com' }, ambiguous: false },
    });
    const tab = context.pages().find((p) => new URL(p.url()).hostname.endsWith('kestrelmart.com'));
    expect(tab, 'a tab is on the resolved website').toBeTruthy();
    await expect(tab!).toHaveTitle(/Kestrelmart/);
    expect(net.searchEngine, 'no search engine was used').toEqual([]);
    // The for-sale candidate was probed and rejected, never opened in a tab.
    const forSale = run.result.navigation?.resolution?.candidates.find(
      (c) => c.domain === 'kestrelmart.in',
    );
    expect(forSale?.verdict).toBe('rejected');
  });

  test('different wording + Hinglish: resolve, open and search in one request', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, `${BRAND} pe steel tiffin dhoondo`);
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    const tab = context.pages().find((p) => p.url().includes('kestrelmart.com/search'));
    expect(tab, 'search results on the resolved website').toBeTruthy();
    expect(new URL(tab!.url()).searchParams.get('q')).toBe('steel tiffin');
    expect(net.searchEngine).toEqual([]);
  });

  test('two equally plausible websites: asks the user, navigates nowhere', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      `take me to the ${AMBIGUOUS_BRAND} website`,
    );
    expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
    expect(run.result.error?.code).toBe('AMBIGUOUS_WEBSITE');
    expect(run.result.error?.message).toMatch(/orbisfix\.in/);
    expect(navigations(run)).toHaveLength(0);
    expect(net.searchEngine).toEqual([]);
  });

  test('an unresolvable name falls back to search discovery as the LAST resort and hands over', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, `Open ${UNKNOWN_BRAND}`);
    expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
    expect(run.result.error?.code).toBe('WEBSITE_NOT_RESOLVED');
    expect(net.brandRequests.length, 'resolution was attempted first').toBeGreaterThan(0);
    expect(net.searchEngine.some((u) => u.includes('/search?q=Zzqxvbrand'))).toBe(true);
  });
});

test.describe('current tab and task continuity', () => {
  test('explicit "in the current tab": searches the open site, no navigation', async ({
    context,
    extensionId,
  }) => {
    const site = await openActive(context, extensionId, 'https://form.fixture.test/');
    const run = await runAgentTask(
      context,
      extensionId,
      'In the current tab, search for garden hose.',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(navigations(run)).toHaveLength(0);
    expect(run.result.navigation).toMatchObject({
      targetSource: 'CURRENT_TAB',
      navigationPolicy: 'REUSE_CURRENT_CONTEXT',
      reusedTab: true,
    });
    expect(new URL(site.url()).searchParams.get('q')).toBe('garden hose');
    expect(net.searchEngine).toEqual([]);
  });

  test('implicit: "Search for …" continues on the open site (script-driven search)', async ({
    context,
    extensionId,
  }) => {
    const site = await openActive(context, extensionId, 'https://spa.fixture.test/');
    const run = await runAgentTask(context, extensionId, 'Search for bluetooth speakers.');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(navigations(run)).toHaveLength(0);
    expect(run.result.navigation?.targetSource).toBe('CURRENT_PAGE');
    expect(site.url()).toBe('https://spa.fixture.test/s?query=bluetooth%20speakers');
  });

  test('search and play on an open media site stays on that site', async ({
    context,
    extensionId,
  }) => {
    const site = await openActive(context, extensionId, 'https://video.fixture.test/');
    const run = await runAgentTask(context, extensionId, 'Search for tabla solo and play one.');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(navigations(run)).toHaveLength(0);
    expect(new URL(site.url()).pathname).toBe('/watch');
    expect(await site.evaluate(() => !document.querySelector('video')!.paused)).toBe(true);
  });

  test("two commands: the second continues in the first command's tab", async ({
    context,
    extensionId,
  }) => {
    const first = await runAgentTask(context, extensionId, 'Open form.fixture.test');
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    const tabsAfterFirst = context.pages().length;
    const second = await runAgentTask(context, extensionId, 'look up desk lamp');
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    expect(navigations(second)).toHaveLength(0);
    expect(second.result.tabId).toBe(first.result.tabId);
    expect(context.pages().length).toBe(tabsAfterFirst);
    const tab = context.pages().find((p) => p.url().startsWith('https://form.fixture.test/search'));
    expect(new URL(tab!.url()).searchParams.get('q')).toBe('desk lamp');
    expect(net.searchEngine).toEqual([]);
  });

  test('user bugs B1+B5: "now click the second product" opens it once (new-tab link), then a bare query continues there', async ({
    context,
    extensionId,
  }) => {
    const first = await runAgentTask(
      context,
      extensionId,
      'Open newtab.fixture.test and search for iphone',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    const tabsBefore = context.pages().length;

    // User wording that used to be typed into Google, on a site whose products open in a new tab.
    const second = await runAgentTask(context, extensionId, 'now click the second product');
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    const products = context.pages().filter((p) => p.url().includes('newtab.fixture.test/item/'));
    expect(products.map((p) => new URL(p.url()).pathname)).toEqual(['/item/2']); // once, no duplicates
    expect(context.pages().length).toBe(tabsBefore + 1);
    expect(second.result.tabId).not.toBe(first.result.tabId); // the agent moved to the product tab

    // "go back" in that new tab returns to the results it came from (live Flipkart bug).
    const back = await runAgentTask(context, extensionId, 'go back');
    expect(back.result.status, explain(back)).toBe('COMPLETED');
    expect(back.result.tabId).toBe(second.result.tabId);
    const backTab = context
      .pages()
      .filter((p) => p.url().startsWith('https://newtab.fixture.test/search'));
    expect(backTab).toHaveLength(2); // the original results tab + the product tab, now on the results

    // A bare query (no "search" verb) continues on the open site — never Google.
    const third = await runAgentTask(context, extensionId, 'iphone 15');
    expect(third.result.status, explain(third)).toBe('COMPLETED');
    expect(third.result.tabId).toBe(second.result.tabId);
    // The product tab itself now shows the new search; the original results tab is untouched.
    const queries = context
      .pages()
      .filter((p) => p.url().startsWith('https://newtab.fixture.test/search'))
      .map((p) => new URL(p.url()).searchParams.get('q'));
    expect(queries.sort()).toEqual(['iphone', 'iphone 15']);
    expect(context.pages().some((p) => p.url().includes('/item/'))).toBe(false);
    expect(context.pages().length).toBe(tabsBefore + 1);
    expect(net.searchEngine).toEqual([]);
  });

  test('"play the second result" uses the results already on screen', async ({
    context,
    extensionId,
  }) => {
    const first = await runAgentTask(
      context,
      extensionId,
      'search video.fixture.test for sitar ragas',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    const second = await runAgentTask(context, extensionId, 'Play the second result.');
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    expect(navigations(second)).toHaveLength(0);
    const tab = context.pages().find((p) => p.url().includes('video.fixture.test/watch'));
    // resultsList: #1 "<q> — top rated pick", #2 "Best <q> of the year" → /watch?v=2
    expect(new URL(tab!.url()).searchParams.get('v')).toBe('2');
    expect(second.result.steps.map((s) => s.goal)).toEqual(['use-context', 'open-result']);
  });

  test('navigates away only when the open page cannot satisfy the request', async ({
    context,
    extensionId,
  }) => {
    await openActive(context, extensionId, 'https://plain.fixture.test/');
    const run = await runAgentTask(context, extensionId, 'search for garden hose');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.navigation).toMatchObject({
      targetSource: 'SEARCH_DISCOVERY',
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
    });
    expect(net.searchEngine.some((u) => u.includes('q=garden+hose'))).toBe(true);
  });

  test('explicit current tab with no web page open fails honestly', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, 'search here for garden hose');
    expect(run.result.status).toBe('FAILED');
    expect(run.result.error?.code).toBe('CURRENT_TAB_UNAVAILABLE');
    expect(navigations(run)).toHaveLength(0);
    expect(net.searchEngine).toEqual([]);
  });
});
