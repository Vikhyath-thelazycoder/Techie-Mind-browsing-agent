import type { BrowserContext, Page } from '@playwright/test';
import { driverPage, explain, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';
import { SYNTHETIC_PII } from './sites.js';

/**
 * Phase 5 in real Chromium: the built extension carries real workflows on fixture sites — search →
 * filter by price → cheapest; scroll; back; add to cart → stop at payment; fill a form from the
 * encrypted profile (typed through vault tokens, never submitted); summarize; trusted media click.
 */
test.describe.configure({ timeout: 120_000 });

const STORE = 'https://store.fixture.test';

function tab(context: BrowserContext, prefix: string): Page | undefined {
  return context.pages().find((p) => p.url().startsWith(prefix));
}

async function openActive(context: BrowserContext, extensionId: string, url: string) {
  await driverPage(context, extensionId);
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

test.describe('Phase 5 workflows — real browser', () => {
  test('"Open store and search for laptops under ₹50,000" → only the two that fit; then "open the cheapest one"', async ({
    context,
    extensionId,
  }) => {
    const first = await runAgentTask(context, extensionId, `Open store.fixture.test and search for laptops under ₹50,000`);
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    expect(first.result.steps.map((s) => s.goal)).toEqual(['navigate', 'search', 'extract']);
    const out = first.result.output;
    expect(out?.kind).toBe('items');
    if (out?.kind === 'items') {
      expect(out.total).toBe(4);
      // Struck-through old prices ignored; only ₹34,990 and ₹45,490 are within ₹50,000.
      expect(out.items.map((i) => [i.title, i.price])).toEqual([
        ['HP 255 G9 laptop', 34990],
        ['Lenovo IdeaPad Slim 3 laptop', 45490],
      ]);
    }
    const second = await runAgentTask(context, extensionId, 'now open the cheapest one');
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    expect(second.result.timings.modelCalls).toBe(0);
    expect(new URL(tab(context, `${STORE}/p/`)!.url()).pathname).toBe('/p/2');
    const back = await runAgentTask(context, extensionId, 'go back');
    expect(back.result.status, explain(back)).toBe('COMPLETED');
    expect(tab(context, `${STORE}/search`)).toBeTruthy();
    const scroll = await runAgentTask(context, extensionId, 'scroll down');
    expect(scroll.result.status, explain(scroll)).toBe('COMPLETED');
    expect(await tab(context, `${STORE}/search`)!.evaluate(() => scrollY)).toBeGreaterThan(100);
  });

  test('"add it to cart" is verified; "go to checkout" opens the cart; the checkout button is handed over', async ({
    context,
    extensionId,
  }) => {
    const product = await openActive(context, extensionId, `${STORE}/p/3`);
    const add = await runAgentTask(context, extensionId, 'add it to cart');
    expect(add.result.status, explain(add)).toBe('COMPLETED');
    expect(await product.locator('#cart-count').textContent()).toBe('1');
    expect(await product.locator('#msg').textContent()).toBe('Added to cart');
    const cart = await runAgentTask(context, extensionId, 'go to checkout');
    expect(cart.result.status, explain(cart)).toBe('COMPLETED');
    expect(new URL(product.url()).pathname).toBe('/cart');
    const pay = await runAgentTask(context, extensionId, 'proceed to checkout');
    expect(pay.result.status, explain(pay)).toBe('HUMAN_REQUIRED');
    expect(pay.result.error?.message).toMatch(/payment/i);
    expect(new URL(product.url()).pathname).toBe('/cart');
  });

  test('"fill my delivery address" from the encrypted profile: filled, verified, never submitted, nothing leaked', async ({
    context,
    extensionId,
  }) => {
    // Save the profile through the real Settings page (encrypted in the extension).
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings/index.html#profile`);
    const fill: Array<[string, string]> = [
      ['fullName', SYNTHETIC_PII.name],
      ['email', SYNTHETIC_PII.email],
      ['phone', SYNTHETIC_PII.phone],
      ['addressLine1', '12 MG Road'],
      ['city', 'Bengaluru'],
      ['state', 'Karnataka'],
      ['postalCode', '560001'],
    ];
    for (const [field, value] of fill) await settings.getByTestId(`profile-${field}`).fill(value);
    await settings.getByTestId('save-profile').click();
    await expect(settings.getByTestId('profile-status')).toContainText('Saved');
    const stored = await settings.evaluate(() => chrome.storage.local.get(null));
    const storedText = JSON.stringify(stored);
    for (const [, value] of fill) expect(storedText, 'profile stored in clear').not.toContain(value);

    const form = await openActive(context, extensionId, `${STORE}/address`);
    const run = await runAgentTask(context, extensionId, 'fill my delivery address');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    const values = await form.evaluate(() =>
      Object.fromEntries(
        Array.from(document.querySelectorAll('input,select')).map((e) => [
          (e as HTMLInputElement).name,
          (e as HTMLInputElement).value,
        ]),
      ),
    );
    expect(values, JSON.stringify(run.result.output)).toMatchObject({
      fullname: SYNTHETIC_PII.name,
      email: SYNTHETIC_PII.email,
      mobile: SYNTHETIC_PII.phone,
      address1: '12 MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pin: '560001',
      company: '',
      password: '',
    });
    expect(await form.title()).not.toBe('SUBMITTED');
    // No profile value in the event stream, the result, history or the audit log.
    const history = await settings.evaluate(() => chrome.storage.local.get(['techieMind.history', 'techieMind.audit']));
    const visible = JSON.stringify([run.events, run.result, history]);
    for (const [, value] of fill.slice(0, 3)) expect(visible).not.toContain(value);
  });

  test('"summarize this page": extracted locally, personal data redacted, shown in the result', async ({
    context,
    extensionId,
  }) => {
    await openActive(context, extensionId, `${STORE}/news`);
    const run = await runAgentTask(context, extensionId, 'summarize this page');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.output).toMatchObject({ kind: 'text', source: 'extractive' });
    if (run.result.output?.kind === 'text') {
      expect(run.result.output.text).toMatch(/monsoon reached the Kerala coast/);
      expect(run.result.output.text).not.toContain(SYNTHETIC_PII.email);
      expect(run.result.output.text).not.toContain(SYNTHETIC_PII.phone);
    }
  });

  test('"play the second result": a trusted click lets playback start with sound (Chrome autoplay rule)', async ({
    context,
    extensionId,
  }) => {
    const results = await openActive(context, extensionId, 'https://tube.fixture.test/results?q=kannada+songs');
    const run = await runAgentTask(context, extensionId, 'play the second result');
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.events.some((e) => e.message.startsWith('Clicked with trusted browser input'))).toBe(true);
    // Independent evidence from the page: a real user gesture, and unmuted playback.
    const state = await results.evaluate(() => {
      const v = document.querySelector('video');
      return {
        activated: navigator.userActivation.hasBeenActive,
        played: document.body.dataset['played'],
        paused: v?.paused ?? null,
        muted: v?.muted ?? null,
      };
    });
    expect(state).toMatchObject({ activated: true, played: 'yes', paused: false, muted: false });
  });
});

test.describe('Phase 5 — trusted media off (autoplay blocked as a real Chrome profile)', () => {
  test.use({ browserArgs: ['--autoplay-policy=user-gesture-required'] });
  test('with trusted clicks disabled the agent opens the video and asks you to press Play', async ({
    context,
    extensionId,
  }) => {
    const panel = await driverPage(context, extensionId);
    await panel.evaluate(async () => {
      const key = 'techieMind.settings';
      const current = ((await chrome.storage.local.get(key))[key] ?? {}) as Record<string, unknown>;
      const agent = (current['agent'] ?? {}) as Record<string, unknown>;
      await chrome.storage.local.set({ [key]: { ...current, agent: { ...agent, trustedMediaClicks: false } } });
    });
    const results = await openActive(context, extensionId, 'https://tube.fixture.test/results?q=kannada+songs');
    const run = await runAgentTask(context, extensionId, 'play the second result');
    expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
    expect(run.result.error?.message).toMatch(/Press Play/);
    expect(await results.evaluate(() => document.body.dataset['played'])).toBe('blocked');
  });
});
