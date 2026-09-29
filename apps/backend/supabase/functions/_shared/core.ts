/**
 * Pure monitoring logic (no I/O): URL rules, reading a price / availability / content fingerprint
 * from a page's HTML, evaluating a monitor's condition and detecting the false → true transition,
 * and the e-mail text. Runs in the Supabase Edge (Deno) worker; kept free of Deno APIs so it is
 * also type-checked with the rest of the repository.
 */

export type MonitorKind = 'price-below' | 'content-changed' | 'available';

/** The monitor row as the worker claims it (snake_case from Postgres). */
export interface MonitorRow {
  id: string;
  user_id: string;
  url: string;
  label: string;
  kind: MonitorKind;
  threshold: number | string | null;
  currency: string | null;
  interval_minutes: number;
  status: string;
  notify_email: string;
  last_value: number | string | null;
  last_hash: string | null;
  last_available: boolean | null;
  condition_met: boolean | null;
  episode: number;
  consecutive_failures: number;
}

// ── URL rules (static part of the SSRF protection; DNS checks happen in safe-fetch) ───────────

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.arpa',
];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** Why a URL may not be monitored, or null when it is acceptable. */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:') return 'only https pages can be monitored';
  if (url.username || url.password) return 'URLs with credentials are not allowed';
  if (url.port && url.port !== '443') return 'only the standard https port (443) is allowed';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.')) return 'the address must be a public website';
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'internal addresses are not allowed';
  }
  if (isIpLiteral(host)) {
    return isPublicIp(host.replace(/^\[|\]$/g, ''))
      ? null
      : 'private or reserved addresses are not allowed';
  }
  if (raw.length > 2048) return 'the address is too long';
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':');
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** Public unicast only: no loopback, private, link-local (cloud metadata), CGNAT, multicast … */
export function isPublicIp(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51) return false;
    if (a === 203 && b === 0) return false;
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (mapped) return isPublicIp(mapped[1]!);
  if (/^(?:fc|fd)/.test(v6)) return false; // unique local
  if (/^fe[89ab]/.test(v6)) return false; // link-local
  if (/^ff/.test(v6)) return false; // multicast
  if (/^64:ff9b:/.test(v6)) return false; // NAT64 (could reach IPv4 private space)
  if (/^2001:(?:db8|0?:)/.test(v6)) return false; // documentation, Teredo
  if (/^2002:/.test(v6)) return false; // 6to4
  return /^[0-9a-f:]+$/.test(v6);
}

// ── reading a page ────────────────────────────────────────────────────────────────────────────

export interface PageReading {
  price: number | null;
  currency: string | null;
  available: boolean | null;
  /** SHA-256 of the normalized visible text (content-changed monitors). */
  hash: string | null;
  /** The page is a bot check / access wall, not the product page. */
  blocked: boolean;
}

const BOT_WALL =
  /captcha|are you a (?:human|robot)|verify you are (?:a )?human|unusual traffic|enter the characters you see|automated access|access denied|request blocked|cf-chl|challenge-platform|press (?:&amp;|&) hold/i;

const CURRENCY_OF: Record<string, string> = {
  '₹': 'INR',
  rs: 'INR',
  'rs.': 'INR',
  inr: 'INR',
  $: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
};

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8377;|&#x20b9;/gi, '₹')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Visible text: scripts, styles and markup removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

interface Offer {
  price: number | null;
  currency: string | null;
  available: boolean | null;
}

function availabilityOf(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;
  if (/InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(value)) return true;
  if (/OutOfStock|SoldOut|Discontinued|BackOrder/i.test(value)) return false;
  return null;
}

/** Product offers from schema.org JSON-LD (the most reliable, site-independent source). */
function jsonLdOffers(html: string): Offer[] {
  const offers: Offer[] = [];
  const blocks = html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    const o = node as Record<string, unknown>;
    const type = String(o['@type'] ?? '');
    if (/Offer/i.test(type)) {
      offers.push({
        price: toNumber(o['price'] ?? o['lowPrice']),
        currency: typeof o['priceCurrency'] === 'string' ? o['priceCurrency'].toUpperCase() : null,
        available: availabilityOf(o['availability']),
      });
    }
    for (const key of ['offers', '@graph', 'mainEntity', 'itemOffered']) {
      if (key in o) visit(o[key], depth + 1);
    }
  };
  for (const match of blocks) {
    try {
      visit(JSON.parse(match[1]!.trim()), 0);
    } catch {
      // Malformed JSON-LD is common; ignore that block.
    }
  }
  return offers;
}

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${name.replace(/[.:]/g, '\\$&')}["'][^>]*>`,
      'i',
    );
    const tag = re.exec(html)?.[0];
    const content = tag ? /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] : null;
    if (content) return content;
  }
  return null;
}

/** "₹ 49,999", "Rs. 1,299.00", "$19.99" in visible text (first occurrence = the main price). */
const TEXT_PRICE = /(₹|rs\.?|inr|\$|€|£)\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i;

export async function readPage(html: string, status: number): Promise<PageReading> {
  const text = visibleText(html);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const blocked =
    status === 403 ||
    status === 429 ||
    status === 503 ||
    BOT_WALL.test(title) ||
    (text.length < 3000 && BOT_WALL.test(text));
  const offers = jsonLdOffers(html);
  const offer = offers.find((o) => o.price !== null) ?? null;
  let price = offer?.price ?? null;
  let currency = offer?.currency ?? null;
  if (price === null) {
    price = toNumber(
      metaContent(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1']),
    );
    const cur = metaContent(html, ['product:price:currency', 'og:price:currency', 'priceCurrency']);
    currency = cur ? cur.toUpperCase() : currency;
  }
  if (price === null) {
    const m = TEXT_PRICE.exec(text);
    if (m) {
      price = toNumber(m[2]);
      currency = CURRENCY_OF[m[1]!.toLowerCase()] ?? null;
    }
  }
  let available = offers.find((o) => o.available !== null)?.available ?? null;
  if (available === null) {
    if (
      /\b(?:out of stock|sold out|currently unavailable|notify me when available|temporarily unavailable)\b/i.test(
        text,
      )
    )
      available = false;
    else if (/\b(?:add to cart|add to basket|add to bag|buy now|in stock)\b/i.test(text))
      available = true;
  }
  return { price, currency, available, hash: await sha256(normalizeForHash(text)), blocked };
}

/** Text used for change detection: numbers that change on every load (times, counters) removed. */
function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/g, ' ')
    .replace(/\b[0-9a-f]{16,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200_000);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── evaluation and transition detection ─────────────────────────────────────────────────────────

export interface Evaluation {
  outcome: 'ok' | 'blocked' | 'error';
  conditionMet: boolean | null;
  /** True only on a transition (false/unknown → true, or a real content change). */
  notify: boolean;
  value: number | null;
  hash: string | null;
  available: boolean | null;
  error: string | null;
}

function num(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function evaluate(monitor: MonitorRow, page: PageReading): Evaluation {
  const base = { value: page.price, hash: page.hash, available: page.available };
  if (page.blocked) {
    return {
      ...base,
      outcome: 'blocked',
      conditionMet: null,
      notify: false,
      error: 'the site showed a bot check instead of the page; will retry later',
    };
  }
  switch (monitor.kind) {
    case 'price-below': {
      const threshold = num(monitor.threshold);
      if (page.price === null || threshold === null) {
        return {
          ...base,
          outcome: 'error',
          conditionMet: null,
          notify: false,
          error: 'no price found on the page',
        };
      }
      if (monitor.currency && page.currency && page.currency !== monitor.currency) {
        return {
          ...base,
          outcome: 'error',
          conditionMet: null,
          notify: false,
          error: `the page shows ${page.currency}, the monitor expects ${monitor.currency}`,
        };
      }
      const met = page.price <= threshold;
      return {
        ...base,
        outcome: 'ok',
        conditionMet: met,
        notify: met && monitor.condition_met !== true,
        error: null,
      };
    }
    case 'available': {
      if (page.available === null) {
        return {
          ...base,
          outcome: 'error',
          conditionMet: null,
          notify: false,
          error: 'could not tell whether it is in stock',
        };
      }
      const met = page.available;
      return {
        ...base,
        outcome: 'ok',
        conditionMet: met,
        notify: met && monitor.condition_met !== true,
        error: null,
      };
    }
    case 'content-changed': {
      // The first check only records the baseline.
      const changed =
        monitor.last_hash !== null && page.hash !== null && page.hash !== monitor.last_hash;
      return { ...base, outcome: 'ok', conditionMet: changed, notify: changed, error: null };
    }
  }
}

// ── e-mail ────────────────────────────────────────────────────────────────────────────────────

/** No line breaks or control characters (header injection), bounded length. */
export function headerSafe(text: string, max = 150): string {
  return text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function money(value: number, currency: string | null): string {
  const symbol =
    currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '₹';
  return `${symbol}${value.toLocaleString(currency === 'INR' || !currency ? 'en-IN' : 'en-US')}`;
}

export function emailFor(monitor: MonitorRow, e: Evaluation): { subject: string; body: string } {
  const name = headerSafe(monitor.label || new URL(monitor.url).hostname, 80);
  const threshold = num(monitor.threshold);
  const subject =
    monitor.kind === 'price-below' && e.value !== null
      ? `Price alert: ${name} is now ${money(e.value, monitor.currency)}`
      : monitor.kind === 'available'
        ? `Back in stock: ${name}`
        : `Page changed: ${name}`;
  const lines = [
    'Techie Mind monitor alert',
    '',
    monitor.kind === 'price-below' && e.value !== null && threshold !== null
      ? `The price is ${money(e.value, monitor.currency)} — at or below your target of ${money(threshold, monitor.currency)}.`
      : monitor.kind === 'available'
        ? 'The item is available again.'
        : 'The page content changed since the last check.',
    '',
    `Page: ${monitor.url}`,
    `Checked: ${new Date().toUTCString()}`,
    '',
    'You get one e-mail per change. Pause or cancel this monitor in Techie Mind → Settings → Monitoring.',
  ];
  return { subject: headerSafe(subject, 190), body: lines.join('\n').slice(0, 4000) };
}

/** A plausible single e-mail address (no display names, no line breaks, no lists). */
export function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@<>,;"'()]+@[^\s@<>,;"'()]+\.[^\s@<>,;"'()]+$/.test(value);
}
