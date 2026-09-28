import { mkdirSync, writeFileSync } from 'node:fs';
import { percentile } from '@techie-mind/telemetry';
import { expect, FIXTURE_ORIGIN, test } from './fixtures.js';

/**
 * Phase 0 performance baseline (real Chromium, headless). Records evidence to
 * evidence/perf-phase0.json. Thresholds are sanity bounds, not targets.
 */
test('performance baseline: messaging latency, panel load, memory', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const panel = await context.newPage();
  const loadStart = Date.now();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  await expect(panel.getByRole('heading', { name: 'What are we doing today?' })).toBeVisible();
  const panelVisibleMs = Date.now() - loadStart;

  const nav = await panel.evaluate(() => {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      domContentLoadedMs: entry ? entry.domContentLoadedEventEnd - entry.startTime : null,
      loadMs: entry ? entry.loadEventEnd - entry.startTime : null,
      usedJSHeapBytes: memory?.usedJSHeapSize ?? null,
    };
  });

  // Side panel → service worker round trip (schema-validated on both ends).
  const healthSamples = await panel.evaluate(async () => {
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await chrome.runtime.sendMessage({ type: 'HEALTH_REQUEST' });
      samples.push(performance.now() - t);
    }
    return samples.slice(10); // drop warm-up
  });

  // Service worker → content script round trip in a live page.
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/`);
  await page.waitForLoadState('load');
  const contentSamples = await serviceWorker.evaluate(async (origin) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(origin));
    if (tab?.id === undefined) throw new Error('fixture tab not found');
    // Content script is injected on demand (Phase 1); inject it as the agent would.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_PING' });
      samples.push(performance.now() - t);
    }
    return samples.slice(10);
  }, FIXTURE_ORIGIN);

  const summarize = (s: number[]) => ({
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
  });

  const evidence = {
    measuredAt: new Date().toISOString(),
    environment: 'Playwright Chromium (headless), local machine',
    sidePanel: { visibleMs: panelVisibleMs, ...nav },
    panelToServiceWorkerMs: summarize(healthSamples),
    serviceWorkerToContentScriptMs: summarize(contentSamples),
  };
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/perf-phase0.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));

  expect(evidence.panelToServiceWorkerMs.p95).toBeLessThan(250);
  expect(evidence.serviceWorkerToContentScriptMs.p95).toBeLessThan(250);
  expect(panelVisibleMs).toBeLessThan(5_000);
});
