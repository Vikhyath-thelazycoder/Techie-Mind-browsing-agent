import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { driverPage, explain, runAgentTask, type AgentRun } from '../browser/agent-helpers.js';
import { expect, test } from '../browser/fixtures.js';
import { decodePng } from '../browser/model-standins.js';
import { LIVE_BROWSER_ARGS } from './live-helpers.js';

/**
 * Batch B — Phase 5 live milestone on REAL websites (YouTube, Flipkart, Amazon, a public form,
 * Wikipedia) with the built extension. Every scenario records sentence | result | ms | evidence to
 * evidence/batch-b-milestone.json and a screenshot in evidence/. Checks are made independently of
 * the agent (page state, URLs, storage, downloads). The test profile is FAKE data only.
 */
test.describe.configure({ timeout: 300_000, mode: 'serial' });
test.use({ browserArgs: LIVE_BROWSER_ARGS }); // default Chrome autoplay policy: sound needs a gesture

const OUT = 'evidence/batch-b-milestone.json';
type Row = {
  id: string;
  sentence: string;
  result: string;
  ms: number;
  evidence: string;
  note: string;
};

function record(row: Row) {
  mkdirSync('evidence', { recursive: true });
  const rows: Row[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Row[]) : [];
  writeFileSync(OUT, JSON.stringify([...rows.filter((r) => r.id !== row.id), row], null, 2));
}

async function shot(page: Page | undefined, id: string): Promise<string> {
  const path = `evidence/batch-b-live-${id}.png`;
  if (page && !page.isClosed()) await page.screenshot({ path }).catch(() => undefined);
  return path;
}

/** Run one sentence, check it, and always record the row (pass or fail) before asserting. */
async function scenario(
  context: BrowserContext,
  extensionId: string,
  id: string,
  sentence: string,
  check: (run: AgentRun) => Promise<{ page?: Page | undefined; note: string }>,
): Promise<AgentRun> {
  const run = await runAgentTask(context, extensionId, sentence);
  let outcome: { page?: Page | undefined; note: string } = { note: '' };
  let error: unknown = null;
  try {
    outcome = await check(run);
  } catch (e) {
    error = e;
  }
  const page = outcome.page ?? context.pages().at(-1);
  record({
    id,
    sentence,
    result: error ? `FAIL (${run.result.status})` : `PASS (${run.result.status})`,
    ms: run.wallMs,
    evidence: await shot(page, id),
    note: error
      ? `${String((error as Error).message ?? error)
          .split('\n')[0]!
          .slice(0, 300)} | ${run.result.error?.message ?? ''}`
      : outcome.note,
  });
  if (error) throw new Error(`${String((error as Error).message)}\n${explain(run)}`);
  return run;
}

const tabOn = (context: BrowserContext, host: RegExp) =>
  context.pages().filter((p) => host.test(p.url()));

async function downloads(worker: Worker) {
  return worker.evaluate(async () =>
    (await chrome.downloads.search({})).map((d) => ({
      file: d.filename,
      mime: d.mime,
      state: d.state,
    })),
  );
}
async function downloaded(worker: Worker, mime: RegExp) {
  await expect
    .poll(
      async () =>
        (await downloads(worker)).some((d) => d.state === 'complete' && mime.test(d.mime)),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  return (await downloads(worker)).filter((d) => mime.test(d.mime)).at(-1)!.file;
}

async function openActive(context: BrowserContext, extensionId: string, url: string) {
  await driverPage(context, extensionId);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  return page;
}

// ── a. YouTube with sound ────────────────────────────────────────────────────────────────────

test('a. "play a Kannada song on YouTube" plays WITH sound, no Press Play handover', async ({
  context,
  extensionId,
}) => {
  await scenario(context, extensionId, 'a', 'play a Kannada song on YouTube', async (run) => {
    const page = tabOn(context, /youtube\.com\/(watch|shorts)/)[0];
    expect(page, 'no YouTube video tab').toBeTruthy();
    const sample = () =>
      page!.evaluate(() => {
        const v = Array.from(document.querySelectorAll('video')).sort(
          (x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight,
        )[0];
        return {
          t: v?.currentTime ?? -1,
          paused: v?.paused ?? null,
          muted: v?.muted ?? null,
          volume: v?.volume ?? null,
          activated: navigator.userActivation.hasBeenActive,
        };
      });
    const s1 = await sample();
    await page!.waitForTimeout(3000);
    const s2 = await sample();
    expect(run.result.status, run.result.error?.message).toBe('COMPLETED');
    expect(s2.paused).toBe(false);
    expect(s2.muted).toBe(false);
    expect(s2.t).toBeGreaterThan(s1.t);
    expect(s2.activated).toBe(true);
    const trusted = run.events.some((e) => /trusted browser input/i.test(e.message));
    return {
      page,
      note: `watch page, unmuted, volume ${s2.volume}, t ${s1.t.toFixed(1)}→${s2.t.toFixed(1)} s, user gesture ${s2.activated}, trusted click ${trusted}`,
    };
  });
});

// ── b + c. Flipkart price filter, cheapest, back, scroll ─────────────────────────────────────

test('b+c. Flipkart: laptops under ₹50,000 → cheapest → back → scroll', async ({
  context,
  extensionId,
}) => {
  const b = await scenario(
    context,
    extensionId,
    'b',
    'search laptops under ₹50,000 on Flipkart',
    async (run) => {
      expect(run.result.status).toBe('COMPLETED');
      const out = run.result.output;
      expect(out?.kind).toBe('items');
      if (out?.kind !== 'items') throw new Error('no items');
      expect(out.items.length).toBeGreaterThan(0);
      for (const it of out.items) {
        expect(it.price, it.title).not.toBeNull();
        expect(it.price!, it.title).toBeLessThanOrEqual(50_000);
      }
      const prices = out.items.map((i) => i.price!);
      return {
        page: tabOn(context, /flipkart\.com/)[0],
        note: `${out.items.length}/${out.total} items kept, ₹${Math.min(...prices)}–₹${Math.max(...prices)}`,
      };
    },
  );
  const cheapest =
    b.result.output?.kind === 'items'
      ? Math.min(...b.result.output.items.map((i) => i.price ?? Infinity))
      : null;

  await scenario(context, extensionId, 'c1', 'open the cheapest one', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    expect(run.result.timings.modelCalls).toBe(0);
    const product = context.pages().find((p) => /flipkart\.com\/.+\/p\//.test(p.url()));
    expect(product, 'no Flipkart product page').toBeTruthy();
    const text = await product!.evaluate(() => document.body.innerText.replace(/\s+/g, ''));
    const shown = cheapest ? `₹${cheapest.toLocaleString('en-IN')}` : '';
    return {
      page: product,
      note: `product page ${new URL(product!.url()).pathname.slice(0, 60)}; cheapest listed ₹${cheapest}; price on page ${text.includes(shown) ? 'matches' : 'NOT found'}`,
    };
  });

  await scenario(context, extensionId, 'c2', 'go back', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const page = context.pages().find((p) => /flipkart\.com\/search/.test(p.url()));
    expect(page, 'not back on the results').toBeTruthy();
    return { page, note: 'back on the results page' };
  });

  await scenario(context, extensionId, 'c3', 'scroll down', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    // Two Flipkart tabs exist (the original results + the product tab that went back to them); the
    // agent scrolls the tab it works in, so look at every Flipkart tab.
    const pages = tabOn(context, /flipkart\.com/);
    const ys = await Promise.all(pages.map((p) => p.evaluate(() => window.scrollY)));
    const i = ys.indexOf(Math.max(...ys));
    expect(ys[i]).toBeGreaterThan(0);
    return { page: pages[i], note: `scrollY ${ys[i]} in the agent's tab` };
  });
});

// ── d + e. Amazon cheapest, add to cart, cart, checkout handover ─────────────────────────────

test('d+e. Amazon: iPhone 15 → cheapest → add to cart → cart → checkout handed over', async ({
  context,
  extensionId,
}) => {
  await scenario(context, extensionId, 'd1', 'search iPhone 15 on Amazon', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const out = run.result.output;
    return {
      page: tabOn(context, /amazon\./)[0],
      note:
        out?.kind === 'items'
          ? `${out.items.length} items with prices read`
          : `output ${out?.kind ?? 'none'}`,
    };
  });
  await scenario(context, extensionId, 'd2', 'open the cheapest one', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    expect(run.result.timings.modelCalls).toBe(0);
    const product = context
      .pages()
      .find((p) => /amazon\.[a-z.]+\/.*(dp|gp\/product)\//.test(p.url()));
    expect(product, 'no Amazon product page').toBeTruthy();
    return { page: product, note: new URL(product!.url()).pathname.slice(0, 70) };
  });
  await scenario(context, extensionId, 'e1', 'add to cart', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const verify = run.result.steps.map((s) => s.evidence).join(' | ');
    expect(verify).toMatch(/cart|added/i);
    return { note: verify.slice(0, 200) };
  });
  await scenario(context, extensionId, 'e2', 'go to cart', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const cart = context.pages().find((p) => /amazon\.[a-z.]+\/(gp\/cart|cart)/.test(p.url()));
    expect(cart, 'not on the cart page').toBeTruthy();
    return { page: cart, note: new URL(cart!.url()).pathname };
  });
  await scenario(context, extensionId, 'e3', 'checkout', async (run) => {
    expect(run.result.status).toBe('HUMAN_REQUIRED');
    const leaked = context.pages().some((p) => /checkout|\/buy\/|signin|ap\/signin/i.test(p.url()));
    expect(leaked, 'a checkout/sign-in page was opened').toBe(false);
    return { note: run.result.error?.message.slice(0, 200) ?? '' };
  });
});

// ── f. profile → fill a real public address form, never submitted ──────────────────────────

const FAKE = {
  fullName: 'Asha Testuser',
  email: 'asha.testuser@example.com',
  phone: '9000000001',
  addressLine1: '12 Test Street, Sample Nagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

test('f. fake profile → "fill my delivery address" on a real form: filled, not submitted', async ({
  context,
  extensionId,
}) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/settings/index.html#profile`);
  for (const [field, value] of Object.entries(FAKE))
    await settings.getByTestId(`profile-${field}`).fill(value);
  await settings.getByTestId('save-profile').click();
  await expect(settings.getByTestId('profile-status')).toContainText('Saved');
  await settings.close();

  const form = await openActive(
    context,
    extensionId,
    'https://demoqa.com/automation-practice-form',
  );
  await scenario(context, extensionId, 'f', 'fill my delivery address', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const values = await form.evaluate(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll('input, textarea'))
          .filter((e) => (e as HTMLInputElement).value)
          .map((e) => [
            (e as HTMLElement).id || (e as HTMLInputElement).name,
            (e as HTMLInputElement).value,
          ]),
      ),
    );
    const filled = Object.values(values).join(' | ');
    expect(filled).toContain(FAKE.email);
    const submitted = await form
      .locator('#example-modal-sizes-title-lg')
      .isVisible()
      .catch(() => false);
    expect(submitted, 'the form was submitted').toBe(false);
    const secrets = await form.evaluate(
      () =>
        Array.from(
          document.querySelectorAll(
            'input[type=password], input[autocomplete*=cc], input[autocomplete=one-time-code]',
          ),
        )
          .map((e) => (e as HTMLInputElement).value)
          .filter(Boolean).length,
    );
    expect(secrets).toBe(0);
    return {
      page: form,
      note: `filled: ${Object.keys(values).join(', ')}; not submitted; no password/OTP/card values`,
    };
  });
});

// ── g. summary of an article ────────────────────────────────────────────────────────────────

test('g. "summarize this page" on a real article', async ({ context, extensionId }) => {
  const news = await openActive(context, extensionId, 'https://www.bbc.com/news');
  const href = await news
    .locator('a[href*="/news/articles/"]')
    .first()
    .getAttribute('href')
    .catch(() => null);
  const url = href
    ? new URL(href, 'https://www.bbc.com').href
    : 'https://en.wikipedia.org/wiki/Chandrayaan-3';
  await news.goto(url, { waitUntil: 'domcontentloaded' });
  await scenario(context, extensionId, 'g', 'summarize this page', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const out = run.result.output;
    expect(out?.kind).toBe('text');
    if (out?.kind !== 'text') throw new Error('no summary');
    expect(out.text.length).toBeGreaterThan(80);
    return {
      page: news,
      note: `${out.source} summary, ${out.text.length} chars, of ${new URL(url).host}${new URL(url).pathname.slice(0, 50)}`,
    };
  });
});

// ── skills ──────────────────────────────────────────────────────────────────────────────────

test('skills on real pages', async ({ context, extensionId, serviceWorker }) => {
  const wiki = await openActive(
    context,
    extensionId,
    'https://en.wikipedia.org/wiki/List_of_states_and_union_territories_of_India_by_population',
  );
  const soft = async (
    id: string,
    sentence: string,
    check: (run: AgentRun) => Promise<{ page?: Page | undefined; note: string }>,
  ) => scenario(context, extensionId, id, sentence, check).catch(() => null);

  await soft('s1', 'bookmark this page', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const found = await serviceWorker.evaluate(
      async () => (await chrome.bookmarks.search({ query: 'population' })).length,
    );
    expect(found).toBeGreaterThan(0);
    return { page: wiki, note: `${found} bookmark(s) in Chrome` };
  });
  await soft('s2', 'show my bookmarks for population', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    expect(JSON.stringify(run.result.output)).toMatch(/population/i);
    return { note: 'listed' };
  });
  await soft('s3', 'save this for later', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    return { note: 'saved' };
  });
  await soft('s4', 'show my reading list', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    expect(JSON.stringify(run.result.output)).toMatch(/population/i);
    return { note: 'listed' };
  });
  await wiki.bringToFront();
  await soft('s5', 'save this page', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const file = await downloaded(serviceWorker, /markdown/);
    const md = readFileSync(file, 'utf8');
    expect(md.length).toBeGreaterThan(200);
    return { page: wiki, note: `Markdown ${md.length} chars` };
  });
  await wiki.bringToFront();
  await soft('s6', 'export the table as csv', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const file = await downloaded(serviceWorker, /csv/);
    const csv = readFileSync(file, 'utf8');
    expect(csv.split('\n').length).toBeGreaterThan(10);
    return {
      page: wiki,
      note: `CSV ${csv.split('\n').length} lines; head: ${csv.split('\n')[0]!.slice(0, 80)}`,
    };
  });
  // Grouping needs two or more tabs of one site: open a second Wikipedia tab first.
  await openActive(context, extensionId, 'https://en.wikipedia.org/wiki/Bengaluru');
  await soft('s7', 'organize my tabs', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const groups = await serviceWorker.evaluate(async () =>
      (await chrome.tabGroups.query({})).map((g) => g.title),
    );
    expect(groups.length).toBeGreaterThan(0);
    return { note: `groups: ${groups.join(', ')}` };
  });

  // Walkthrough on a page with the (fake) profile typed in: personal data must be painted over.
  const form = await openActive(
    context,
    extensionId,
    'https://demoqa.com/automation-practice-form',
  );
  await form.fill('#userEmail', FAKE.email);
  await form.fill('#userNumber', FAKE.phone);
  const box = await form.locator('#userEmail').boundingBox();
  const viewport = form.viewportSize()!;
  await soft('s8', 'take a screenshot walkthrough', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const file = await downloaded(serviceWorker, /png/);
    const png = decodePng(readFileSync(file).toString('base64'));
    const scale = png.width / viewport.width;
    let note = `PNG ${png.width}×${png.height}`;
    if (box && box.y + box.height < viewport.height) {
      const [r, g, b] = png.pixel(
        Math.round((box.x + 20) * scale),
        Math.round((box.y + box.height / 2) * scale),
      );
      expect([r, g, b], 'e-mail field must be painted over').toEqual([0, 0, 0]);
      note += '; e-mail field painted black';
    } else note += '; e-mail field off-screen (not checked)';
    return { page: form, note };
  });

  await soft('s9', 'compare iPhone 15 prices on Amazon and Flipkart', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const out = run.result.output;
    expect(out?.kind).toBe('items');
    const sources = out?.kind === 'items' ? [...new Set(out.items.map((i) => i.source))] : [];
    expect(sources.length).toBeGreaterThanOrEqual(2);
    return {
      note:
        out?.kind === 'items'
          ? out.items.map((i) => `${i.source}: ₹${i.price} ${i.title.slice(0, 40)}`).join(' ; ')
          : '',
    };
  });
  await soft('s10', 'research budget laptops', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const out = JSON.stringify(run.result.output);
    expect(out).toMatch(/https?:\/\//);
    return { note: out.slice(0, 250) };
  });
  const product = await openActive(context, extensionId, 'https://www.amazon.in/s?k=iphone+15');
  await product
    .locator('a[href*="/dp/"]')
    .first()
    .click()
    .catch(() => undefined);
  await product.waitForLoadState('domcontentloaded').catch(() => undefined);
  await product.bringToFront();
  await soft('s11', 'monitor this product until the price drops below ₹50,000', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const monitors = await serviceWorker.evaluate(
      async () => (await chrome.storage.local.get('techieMind.monitors'))['techieMind.monitors'],
    );
    expect(JSON.stringify(monitors)).toMatch(/50000|50,000/);
    return { page: product, note: `monitor stored: ${JSON.stringify(monitors).slice(0, 200)}` };
  });
});

// ── Batch A bug sentences (full regression, milestone) ──────────────────────────────────────

test('regression: Batch A bug sentences on live Flipkart', async ({ context, extensionId }) => {
  const soft = async (
    id: string,
    sentence: string,
    check: (run: AgentRun) => Promise<{ page?: Page | undefined; note: string }>,
  ) => scenario(context, extensionId, id, sentence, check).catch(() => null);

  const first = await soft('r1', 'Open Flipkart iPhone', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const page = context.pages().find((p) => /flipkart\.com\/search\?q=iphone/i.test(p.url()));
    expect(page, 'Flipkart was not searched for iPhone').toBeTruthy();
    expect(run.result.timings.modelCalls).toBe(0);
    return {
      page,
      note: 'Flipkart opened and searched "iPhone" (query not dropped), 0 model calls',
    };
  });
  const tabsBefore = context.pages().length;
  const second = await soft('r2', 'now click the second product', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const products = context.pages().filter((p) => /flipkart\.com\/.+\/p\//.test(p.url()));
    expect(products).toHaveLength(1); // opened once — no duplicates
    return {
      page: products[0],
      note: `one product tab (no duplicates); follow-up acted in the open site, not Google; tabs ${tabsBefore}→${context.pages().length}`,
    };
  });
  await soft('r3', 'iphone 15', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    expect(run.result.timings.modelCalls).toBe(0);
    if (second) expect(run.result.tabId).toBe(second.result.tabId); // same agent tab
    const google = context.pages().some((p) => /google\./.test(p.url()));
    expect(google, 'went to Google').toBe(false);
    const page = context
      .pages()
      .find((p) => /flipkart\.com\/search\?q=iphone(\+|%20)15/i.test(p.url()));
    expect(page, 'no Flipkart search for "iphone 15"').toBeTruthy();
    return {
      page,
      note: 'bare query searched on the open site in the same tab, 0 model calls, no Google',
    };
  });
  await soft('r4', 'play a Kannada song', async (run) => {
    expect(run.result.status).toBe('COMPLETED');
    const q = run.events.find((e) => e.type === 'INTENT_RESOLVED')?.message ?? '';
    expect(q).not.toMatch(/"a Kannada/i); // leading article dropped
    const page = context.pages().find((p) => /youtube\.com\/(watch|shorts)/.test(p.url()));
    expect(page, 'no YouTube video').toBeTruthy();
    return { page, note: `${q}; went to YouTube (media default) and played` };
  });
  void first;
});
