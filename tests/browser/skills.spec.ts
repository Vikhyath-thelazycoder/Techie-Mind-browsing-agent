import { existsSync, readFileSync } from 'node:fs';
import type { BrowserContext, Worker } from '@playwright/test';
import { driverPage, explain, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';

/**
 * Phase 6 in real Chromium: the 12-skill registry drives real browser APIs (bookmarks, tab groups,
 * downloads, storage) and multi-site orchestration through the built extension.
 */
test.describe.configure({ timeout: 150_000 });

const STORE = 'https://store.fixture.test';

async function openActive(context: BrowserContext, extensionId: string, url: string) {
  await driverPage(context, extensionId);
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

async function downloads(worker: Worker) {
  return worker.evaluate(async () =>
    (await chrome.downloads.search({})).map((d) => ({
      file: d.filename,
      mime: d.mime,
      bytes: d.fileSize,
      state: d.state,
    })),
  );
}

test.describe('Phase 6 skills — real browser', () => {
  test('bookmark this page → read back; show bookmarks; remove this bookmark', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await openActive(context, extensionId, `${STORE}/p/1?ref=home`);
    const add = await runAgentTask(context, extensionId, 'bookmark this page');
    expect(add.result.status, explain(add)).toBe('COMPLETED');
    const found = await serviceWorker.evaluate(() =>
      chrome.bookmarks.search({ url: 'https://store.fixture.test/p/1' }),
    );
    expect(found.map((b) => b.url)).toEqual(['https://store.fixture.test/p/1']); // no query string kept
    const list = await runAgentTask(context, extensionId, 'show my bookmarks for dell');
    expect(list.result.output).toMatchObject({ kind: 'list', title: '1 bookmark(s) for "dell"' });
    const remove = await runAgentTask(context, extensionId, 'remove this bookmark');
    expect(remove.result.status, explain(remove)).toBe('COMPLETED');
    expect(
      await serviceWorker.evaluate(() =>
        chrome.bookmarks.search({ url: 'https://store.fixture.test/p/1' }),
      ),
    ).toEqual([]);
  });

  test('organize my tabs → tab groups by site; close duplicate tabs keeps one copy', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await driverPage(context, extensionId);
    for (const u of [
      `${STORE}/p/1`,
      `${STORE}/p/1`,
      `${STORE}/p/2`,
      'https://mart.fixture.test/p/1',
    ]) {
      const p = await context.newPage();
      await p.goto(u);
    }
    await (await context.newPage()).goto(`${STORE}/news`);
    const org = await runAgentTask(context, extensionId, 'organize my tabs');
    expect(org.result.status, explain(org)).toBe('COMPLETED');
    const groups = await serviceWorker.evaluate(async () =>
      (await chrome.tabGroups.query({})).map((g) => g.title),
    );
    expect(groups).toContain('store.fixture.test');
    const close = await runAgentTask(context, extensionId, 'close duplicate tabs');
    expect(close.result.status, explain(close)).toBe('COMPLETED');
    const urls = await serviceWorker.evaluate(async () =>
      (await chrome.tabs.query({})).map((t) => t.url),
    );
    expect(urls.filter((u) => u === 'https://store.fixture.test/p/1')).toHaveLength(1);
  });

  test('read later → stored without query string; save this page → Markdown download', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await openActive(context, extensionId, `${STORE}/news?utm=mail`);
    const later = await runAgentTask(context, extensionId, 'save this for later');
    expect(later.result.status, explain(later)).toBe('COMPLETED');
    const stored = await serviceWorker.evaluate(
      async () => (await chrome.storage.local.get('techieMind.readLater'))['techieMind.readLater'],
    );
    expect(stored).toEqual([expect.objectContaining({ url: 'https://store.fixture.test/news' })]);
    const save = await runAgentTask(context, extensionId, 'save this page');
    expect(save.result.status, explain(save)).toBe('COMPLETED');
    // Playwright stores downloads under generated names; check the type and the file itself.
    await expect
      .poll(
        async () =>
          (await downloads(serviceWorker)).filter(
            (d) => d.state === 'complete' && d.mime === 'text/markdown',
          ).length,
      )
      .toBe(1);
    const file = (await downloads(serviceWorker)).find((d) => d.mime === 'text/markdown')!.file;
    const markdown = existsSync(file) ? readFileSync(file, 'utf8') : '';
    expect(markdown).toMatch(/^# Monsoon arrives in Kerala/);
    expect(markdown).toContain('Source: https://store.fixture.test/news');
    expect(markdown).not.toMatch(/asha\.verma@example\.com|98765 43210/);
    expect(save.result.output).toMatchObject({
      kind: 'list',
      title: 'Saved TechieMind/monsoon-arrives-in-kerala-storekart-news.md',
    });
  });

  test('compare hp laptop prices on two stores → cheapest per store, from each store’s own page', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'compare hp laptop prices on store.fixture.test and mart.fixture.test',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.output?.kind).toBe('items');
    if (run.result.output?.kind !== 'items') throw new Error('no items');
    expect(run.result.output.items.map((i) => [i.source, i.price])).toEqual([
      ['mart.fixture.test', 32990],
      ['store.fixture.test', 34990],
    ]);
    expect(run.result.steps.filter((s) => s.goal === 'search')).toHaveLength(2);
  });

  test('research laptops on the store → three sources read, every bullet cited', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, 'research laptops on store.fixture.test');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.output?.kind).toBe('text');
    if (run.result.output?.kind !== 'text') throw new Error('no text');
    expect(run.result.output.text).toMatch(/\[1\][\s\S]*\[2\][\s\S]*\[3\]/);
    expect(run.result.output.text).toMatch(/Sources:\n\[1\] store\.fixture\.test\/p\//);
  });

  test('screenshot walkthrough → numbered, redacted PNG saved; steps listed', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await openActive(context, extensionId, `${STORE}/search?q=laptops`);
    const run = await runAgentTask(context, extensionId, 'take a screenshot walkthrough');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    if (run.result.output?.kind !== 'list') throw new Error('no list');
    expect(run.result.output.entries[0]).toMatch(/^1\. Search for products/);
    await expect
      .poll(
        async () =>
          (await downloads(serviceWorker)).filter(
            (d) => d.state === 'complete' && d.mime === 'image/png',
          ).length,
      )
      .toBe(1);
    const png = readFileSync(
      (await downloads(serviceWorker)).find((d) => d.mime === 'image/png')!.file,
    );
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(run.result.output.title).toMatch(/store\.fixture\.test-walkthrough\.png/);
  });
});
