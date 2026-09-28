import type { BrowserContext, Page } from '@playwright/test';
import { driverPage, explain, runAgentTask, type AgentRun } from '../browser/agent-helpers.js';
import { expect, test } from '../browser/fixtures.js';
import { LIVE_BROWSER_ARGS, record, searchFieldValue } from './live-helpers.js';

/**
 * Phase 1 correction acceptance on LIVE websites (tests A–I and J wording variants).
 * The agent gets only the sentence. Each test verifies the real browser independently:
 *   - which host each tab ends up on,
 *   - that no search-engine page was ever loaded as a top-level document,
 *   - that "reuse" tasks started no navigation and stayed in the same tab.
 * Playback cases run with autoplay permitted (as live P2) so sustained playback can be verified;
 * without it the agent hands over with "Press Play", which live P1 already covers.
 */
test.describe.configure({ timeout: 180_000 });

const EVIDENCE = 'evidence/phase1-correction-live.json';

/** Top-level documents loaded from any search engine host, by any tab. */
function watchSearchEngine(context: BrowserContext): string[] {
  const hits: string[] = [];
  context.on('request', (request) => {
    if (request.resourceType() !== 'document') return;
    if (request.frame().parentFrame() !== null) return;
    const host = new URL(request.url()).hostname;
    if (/(^|\.)(google|bing|duckduckgo|yahoo)\.[a-z.]+$/.test(host)) hits.push(request.url());
  });
  return hits;
}

async function openActive(
  context: BrowserContext,
  extensionId: string,
  url: string,
): Promise<Page> {
  await driverPage(context, extensionId);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(1_500); // let the live page hydrate like a user would see it
  return page;
}

const navigations = (run: AgentRun) =>
  run.events.filter((e) => e.type === 'NAVIGATION_STARTED').length;

function tabOn(context: BrowserContext, host: RegExp): Page | undefined {
  return context.pages().find((p) => {
    try {
      return host.test(new URL(p.url()).hostname);
    } catch {
      return false;
    }
  });
}

async function mediaPlaying(page: Page): Promise<boolean | null> {
  return page
    .evaluate(() => {
      const main = Array.from(document.querySelectorAll('video')).sort(
        (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
      )[0];
      return main ? !main.paused : null;
    })
    .catch(() => null);
}

function save(
  id: string,
  request: string,
  run: AgentRun,
  page: Page | undefined,
  extra: Record<string, unknown>,
) {
  record(
    {
      name: id,
      request,
      status: run.result.status,
      finalUrl: page?.url() ?? null,
      independent: {
        host: page ? new URL(page.url()).hostname : null,
        path: page ? new URL(page.url()).pathname : null,
        navigationsStarted: navigations(run),
        targetSource: run.result.navigation?.targetSource ?? null,
        navigationPolicy: run.result.navigation?.navigationPolicy ?? null,
        reusedTab: run.result.navigation?.reusedTab ?? null,
        resolvedTo: run.result.navigation?.resolution?.chosen?.domain ?? null,
        agentFinalUrl: run.result.finalUrl,
        candidates: (run.result.navigation?.resolution?.candidates ?? []).map(
          (c) => `${c.domain}: ${c.verdict} (${c.score}) ${c.evidence}`,
        ),
        ...extra,
      },
      timings: run.result.timings,
      wallMs: run.wallMs,
      recovery: run.result.steps.flatMap((s) =>
        s.recovery.map((r) => `${s.goal}:L${r.level}:${r.strategy}`),
      ),
    },
    EVIDENCE,
  );
}

// ── A–D (+ J): arbitrary website names ─────────────────────────────────────────────────────

const WEBSITES: Array<{ id: string; request: string; host: RegExp }> = [
  { id: 'A', request: 'Open Zara.', host: /(^|\.)zara\.com$/ },
  { id: 'B', request: 'Open Snitch.', host: /(^|\.)snitch\.com$/ },
  { id: 'C', request: 'Open Myntra.', host: /(^|\.)myntra\.com$/ },
  { id: 'D', request: 'Open Nike.', host: /(^|\.)nike\.(com|in)$/ },
  { id: 'J-A', request: 'please take me to the Zara website', host: /(^|\.)zara\.com$/ },
  { id: 'J-B', request: 'Snitch website kholo', host: /(^|\.)snitch\.com$/ },
  { id: 'J-C', request: 'go to myntra', host: /(^|\.)myntra\.com$/ },
  { id: 'J-D', request: "visit nike's official site", host: /(^|\.)nike\.(com|in)$/ },
  { id: 'J-R', request: 'Open Reddit', host: /(^|\.)reddit\.com$/ },
];

for (const c of WEBSITES) {
  const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction website';
  test(`${suite} ${c.id}: ${c.request}`, async ({ context, extensionId }) => {
    const engine = watchSearchEngine(context);
    const run = await runAgentTask(context, extensionId, c.request);
    const page = tabOn(context, c.host);
    if (!page)
      console.log(
        `[${c.id}] open tabs: ${context
          .pages()
          .map((p) => p.url())
          .join(' | ')}`,
      );
    if (page) await page.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
    save(c.id, c.request, run, page, { searchEngineLoads: engine.length });
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(page, `a tab on ${c.host}`).toBeTruthy();
    expect(run.result.navigation?.targetSource).toBe('RESOLVED_WEBSITE');
    expect(engine, 'no search engine was used').toEqual([]);
  });
}

// ── E–G (+ J): current tab ─────────────────────────────────────────────────────────────────

test.describe('current tab (autoplay permitted)', () => {
  test.use({ browserArgs: [...LIVE_BROWSER_ARGS, '--autoplay-policy=no-user-gesture-required'] });

  const SEARCH_HERE = [
    { id: 'E', request: 'In the current tab, search for Hindi songs.', query: 'Hindi songs' },
    { id: 'J-E', request: 'search here for bollywood retro songs', query: 'bollywood retro songs' },
  ];
  for (const c of SEARCH_HERE) {
    const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction context';
    test(`${suite} ${c.id}: YouTube tab — ${c.request}`, async ({ context, extensionId }) => {
      const engine = watchSearchEngine(context);
      const tab = await openActive(context, extensionId, 'https://www.youtube.com/');
      const run = await runAgentTask(context, extensionId, c.request);
      await tab.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
      const url = new URL(tab.url());
      save(c.id, c.request, run, tab, {
        param: url.searchParams.get('search_query'),
        field: await searchFieldValue(tab),
        searchEngineLoads: engine.length,
      });
      expect(run.result.status, explain(run)).toBe('COMPLETED');
      expect(navigations(run), 'no navigation').toBe(0);
      expect(run.result.navigation?.targetSource).toBe('CURRENT_TAB');
      expect(url.hostname).toBe('www.youtube.com');
      expect(url.pathname).toBe('/results');
      expect(url.searchParams.get('search_query')?.toLowerCase()).toBe(c.query.toLowerCase());
      expect(engine).toEqual([]);
    });
  }

  const SEARCH_AND_PLAY = [
    { id: 'F', request: 'Search for Hindi songs and play one.' },
    { id: 'J-F', request: 'look up ghazals and play the first one' },
  ];
  for (const c of SEARCH_AND_PLAY) {
    const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction context';
    test(`${suite} ${c.id}: YouTube tab — ${c.request}`, async ({ context, extensionId }) => {
      const engine = watchSearchEngine(context);
      const tab = await openActive(context, extensionId, 'https://www.youtube.com/');
      const run = await runAgentTask(context, extensionId, c.request);
      await tab.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
      const playing = await mediaPlaying(tab);
      save(c.id, c.request, run, tab, { playing, searchEngineLoads: engine.length });
      expect(run.result.status, explain(run)).toBe('COMPLETED');
      expect(navigations(run), 'no navigation').toBe(0);
      expect(run.result.navigation?.reusedTab).toBe(true);
      expect(new URL(tab.url()).pathname).toBe('/watch');
      expect(playing).toBe(true);
      expect(engine).toEqual([]);
    });
  }

  const STORE_TAB = [
    {
      id: 'G',
      start: 'https://www.zara.com/in/en/',
      request: 'Search for black shirts.',
      host: /zara\.com$/,
      terms: ['black', 'shirt'],
    },
    {
      id: 'J-G',
      start: 'https://www.flipkart.com/',
      request: 'look for steel water bottles',
      host: /flipkart\.com$/,
      terms: ['steel', 'water', 'bottle'],
    },
  ];
  for (const c of STORE_TAB) {
    const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction context';
    test(`${suite} ${c.id}: store tab — ${c.request}`, async ({ context, extensionId }) => {
      const engine = watchSearchEngine(context);
      const tab = await openActive(context, extensionId, c.start);
      const run = await runAgentTask(context, extensionId, c.request);
      await tab.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
      const decoded = decodeURIComponent(tab.url()).toLowerCase().replace(/\+/g, ' ');
      save(c.id, c.request, run, tab, {
        field: await searchFieldValue(tab),
        searchEngineLoads: engine.length,
      });
      expect(run.result.status, explain(run)).toBe('COMPLETED');
      expect(navigations(run), 'no navigation').toBe(0);
      expect(run.result.navigation?.targetSource).toBe('CURRENT_PAGE');
      expect(new URL(tab.url()).hostname).toMatch(c.host);
      for (const t of c.terms) expect(decoded, `URL carries "${t}"`).toContain(t);
      expect(engine).toEqual([]);
    });
  }

  // ── H–I (+ J): two commands ──────────────────────────────────────────────────────────────

  const CONTINUITY = [
    {
      id: 'H',
      first: 'Open YouTube.',
      second: 'Search for Kannada songs.',
      query: 'Kannada songs',
    },
    {
      id: 'J-H',
      first: 'go to youtube',
      second: 'find carnatic flute music',
      query: 'carnatic flute music',
    },
  ];
  for (const c of CONTINUITY) {
    const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction continuity';
    test(`${suite} ${c.id}: "${c.first}" then "${c.second}"`, async ({ context, extensionId }) => {
      const engine = watchSearchEngine(context);
      const first = await runAgentTask(context, extensionId, c.first);
      expect(first.result.status, explain(first)).toBe('COMPLETED');
      const second = await runAgentTask(context, extensionId, c.second);
      const tab = tabOn(context, /(^|\.)youtube\.com$/);
      await tab?.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
      save(c.id, `${c.first} → ${c.second}`, second, tab, {
        sameTab: second.result.tabId === first.result.tabId,
        searchEngineLoads: engine.length,
      });
      expect(second.result.status, explain(second)).toBe('COMPLETED');
      expect(navigations(second), 'second command did not navigate').toBe(0);
      expect(second.result.tabId).toBe(first.result.tabId);
      const url = new URL(tab!.url());
      expect(url.pathname).toBe('/results');
      expect(url.searchParams.get('search_query')?.toLowerCase()).toBe(c.query.toLowerCase());
      expect(engine).toEqual([]);
    });
  }

  const RESULTS_CONTEXT = [
    { id: 'I', first: 'Search YouTube for Kannada songs.', second: 'Play the first result.' },
    { id: 'J-I', first: 'search youtube for lofi study music', second: 'play the second one' },
  ];
  for (const c of RESULTS_CONTEXT) {
    const suite = c.id.startsWith('J') ? 'Correction J' : 'Correction continuity';
    test(`${suite} ${c.id}: "${c.first}" then "${c.second}"`, async ({ context, extensionId }) => {
      const engine = watchSearchEngine(context);
      const first = await runAgentTask(context, extensionId, c.first);
      expect(first.result.status, explain(first)).toBe('COMPLETED');
      const second = await runAgentTask(context, extensionId, c.second);
      const tab = tabOn(context, /(^|\.)youtube\.com$/);
      await tab?.screenshot({ path: `evidence/phase1-correction-${c.id}.png` });
      const playing = tab ? await mediaPlaying(tab) : null;
      save(c.id, `${c.first} → ${c.second}`, second, tab, {
        playing,
        sameTab: second.result.tabId === first.result.tabId,
        searchEngineLoads: engine.length,
      });
      expect(second.result.status, explain(second)).toBe('COMPLETED');
      expect(navigations(second)).toBe(0);
      expect(second.result.tabId).toBe(first.result.tabId);
      expect(second.result.steps.map((s) => s.goal)).toEqual(['use-context', 'open-result']);
      // A result can be a regular video (/watch) or a Short (/shorts/…) — both are video pages.
      expect(new URL(tab!.url()).pathname).toMatch(/^\/(?:watch$|shorts\/)/);
      expect(playing).toBe(true);
      expect(engine).toEqual([]);
    });
  }
});
