import { DEFAULT_SETTINGS } from '@techie-mind/config';
import { ModelUsage } from '@techie-mind/contracts';
import type { Intelligence, SummarizeInput } from '@techie-mind/models';
import { describe, expect, it } from 'vitest';
import { run, shop } from './shop-fixture.js';

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
    expect(
      site.executed.some(
        (e) =>
          e.action.binding.target?.kind === 'element' &&
          e.action.binding.target.elementId === 'submit',
      ),
    ).toBe(false);
    // Typed actions carry tokens, never the values; the values travel only in `resolved`.
    const typed = site.executed.filter((e) => e.action.args.type === 'TYPE');
    expect(typed.length).toBe(6);
    for (const t of typed) {
      expect(t.action.args.type === 'TYPE' && 'vaultToken' in t.action.args.input).toBe(true);
      expect(t.resolved?.text).toBeTruthy();
    }
    // No raw profile value in events, TaskResult or the output list.
    const visible = JSON.stringify([events, { ...result, output: result.output }]);
    for (const raw of [
      'Asha Verma',
      'asha.verma@example.com',
      '98765 43210',
      '12 MG Road',
      '560001',
    ]) {
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
  // Live on the Mac: failed with "must be a lowercase hostname" on a page that is not on a public domain.
  it.each(['http://localhost:3000', 'http://192.168.1.20', 'http://intranet'])(
    'summarizes a page served from %s',
    async (origin) => {
      const site = shop('/news', undefined, {}, origin);
      const { result } = await run(site, 'summarize this page');
      expect(result.status).toBe('COMPLETED');
      expect(result.output).toMatchObject({ kind: 'text' });
    },
  );

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
          usage: ModelUsage.parse({
            tier: 'qwen',
            modelId: 'qwen2.5vl:7b',
            purpose: 'plan-action',
            outcome: 'answered',
            latencyMs: 900,
            reason: 'summary',
          }),
        };
      },
    };
    const site = shop('/news');
    const { result } = await run(site, "what's this page about?", {
      intelligence: ai,
      // Settings → Skills: the user's own instructions reach the model for this skill only.
      skillInstructions: { 'summarize-page': '3 bullets, simple English', 'deep-research': 'x' },
    });
    expect(result.output).toMatchObject({ kind: 'text', source: 'model' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.instructions).toBe('3 bullets, simple English');
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
    expect(events.some((e) => e.message.startsWith('Clicked with trusted browser input'))).toBe(
      true,
    );
    // The firewall authorized the same CLICK before the trusted input was used.
    expect(events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
  });

  it('trusted clicks switched off: the agent opens it and asks you to press Play (as before)', async () => {
    const site = shop('/search?q=laptops', null, { trustedInput: true, media: true });
    const settings = {
      ...DEFAULT_SETTINGS,
      agent: { ...DEFAULT_SETTINGS.agent, trustedMediaClicks: false },
    };
    const { result } = await run(site, 'play the second result', { settings });
    expect(site.trusted).toEqual([]);
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/Press Play/);
  }, 20_000);
});
