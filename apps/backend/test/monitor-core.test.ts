import { describe, expect, it } from 'vitest';
import {
  emailFor,
  evaluate,
  headerSafe,
  isEmail,
  isPublicIp,
  readPage,
  urlProblem,
  type MonitorRow,
} from '../supabase/functions/_shared/core.ts';

/** Phase 8 monitoring logic (spec §38–43): SSRF rules, page reading, transitions, e-mail safety. */

const monitor = (over: Partial<MonitorRow> = {}): MonitorRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  user_id: '00000000-0000-4000-8000-000000000002',
  url: 'https://shop.example.com/p/1',
  label: 'Laptop',
  kind: 'price-below',
  threshold: 50000,
  currency: 'INR',
  interval_minutes: 60,
  status: 'active',
  notify_email: 'user@example.com',
  last_value: null,
  last_hash: null,
  last_available: null,
  condition_met: null,
  episode: 0,
  consecutive_failures: 0,
  ...over,
});

describe('SSRF rules (spec §42)', () => {
  it('accepts public https pages only', () => {
    expect(urlProblem('https://www.flipkart.com/p/x')).toBeNull();
    expect(urlProblem('http://example.com/')).toMatch(/https/);
    expect(urlProblem('https://example.com:8443/')).toMatch(/443/);
    expect(urlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(urlProblem('https://localhost/')).toMatch(/public|internal/);
    expect(urlProblem('https://intranet.corp/')).toMatch(/internal/);
    expect(urlProblem('https://metadata.google.internal/')).toMatch(/internal/);
    expect(urlProblem('https://169.254.169.254/latest/meta-data')).toMatch(/private|reserved/);
    expect(urlProblem('https://10.0.0.5/')).toMatch(/private|reserved/);
    expect(urlProblem('https://[::1]/')).toMatch(/public|private|reserved/);
  });

  it('classifies addresses', () => {
    for (const ip of ['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5'])
      expect(isPublicIp(ip)).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '64:ff9b::a00:1',
    ])
      expect(isPublicIp(ip)).toBe(false);
  });
});

describe('reading a page', () => {
  it('prefers schema.org JSON-LD price and stock', async () => {
    const html = `<html><head><title>Laptop</title><script type="application/ld+json">
      {"@type":"Product","offers":{"@type":"Offer","price":"48999","priceCurrency":"INR","availability":"https://schema.org/InStock"}}
      </script></head><body>₹ 99,999 bank offer</body></html>`;
    const page = await readPage(html, 200);
    expect(page).toMatchObject({ price: 48999, currency: 'INR', available: true, blocked: false });
    expect(page.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to meta tags, then visible text', async () => {
    expect(
      await readPage('<meta property="product:price:amount" content="1299.00"><p>x</p>', 200),
    ).toMatchObject({ price: 1299 });
    expect(await readPage('<p>Price: <b>₹49,990</b> Add to Cart</p>', 200)).toMatchObject({
      price: 49990,
      currency: 'INR',
      available: true,
    });
    expect(await readPage('<p>Currently unavailable</p>', 200)).toMatchObject({ available: false });
  });

  it('detects bot walls instead of reading them as the page', async () => {
    expect(
      (await readPage('<title>Robot Check</title><p>Enter the characters you see</p>', 200))
        .blocked,
    ).toBe(true);
    expect((await readPage('<p>ok</p>', 503)).blocked).toBe(true);
  });
});

describe('evaluation and transitions (spec §41)', () => {
  const reading = { price: 48000, currency: 'INR', available: true, hash: 'h2', blocked: false };

  it('notifies once on the false → true transition', () => {
    const first = evaluate(monitor({ condition_met: false }), reading);
    expect(first).toMatchObject({ outcome: 'ok', conditionMet: true, notify: true });
    const again = evaluate(monitor({ condition_met: true }), reading);
    expect(again).toMatchObject({ conditionMet: true, notify: false });
    const above = evaluate(monitor({ condition_met: true }), { ...reading, price: 52000 });
    expect(above).toMatchObject({ conditionMet: false, notify: false });
  });

  it('a blocked page or a missing price is an error, never an alert', () => {
    expect(evaluate(monitor(), { ...reading, blocked: true })).toMatchObject({
      outcome: 'blocked',
      notify: false,
    });
    expect(evaluate(monitor(), { ...reading, price: null })).toMatchObject({
      outcome: 'error',
      notify: false,
    });
    expect(evaluate(monitor(), { ...reading, currency: 'USD' })).toMatchObject({
      outcome: 'error',
      notify: false,
    });
  });

  it('content-changed records a baseline first, then alerts on change', () => {
    const m = monitor({ kind: 'content-changed', threshold: null, currency: null });
    expect(evaluate(m, reading)).toMatchObject({ notify: false });
    expect(evaluate({ ...m, last_hash: 'h1' }, reading)).toMatchObject({ notify: true });
    expect(evaluate({ ...m, last_hash: 'h2' }, reading)).toMatchObject({ notify: false });
  });

  it('back-in-stock alerts when it becomes available', () => {
    const m = monitor({ kind: 'available', threshold: null, currency: null, condition_met: false });
    expect(evaluate(m, reading)).toMatchObject({ notify: true });
    expect(evaluate(m, { ...reading, available: false })).toMatchObject({ notify: false });
  });
});

describe('e-mail safety', () => {
  it('subjects never carry line breaks or control characters', () => {
    const mail = emailFor(monitor({ label: 'Laptop\r\nBcc: attacker@evil.test' }), {
      outcome: 'ok',
      conditionMet: true,
      notify: true,
      value: 48000,
      hash: null,
      available: null,
      error: null,
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toMatch(/₹48,000/);
    expect(headerSafe('a\u0000b\nc')).toBe('a b c');
  });

  it('accepts one plain address only', () => {
    expect(isEmail('user@example.com')).toBe(true);
    for (const bad of [
      'a@b',
      'x y@z.com',
      'a@b.com, c@d.com',
      'Name <a@b.com>',
      'a@b.com\nBcc: c@d.com',
    ])
      expect(isEmail(bad)).toBe(false);
  });
});
