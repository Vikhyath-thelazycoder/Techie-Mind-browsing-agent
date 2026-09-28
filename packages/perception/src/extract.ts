import type { ExtractedItem } from '@techie-mind/contracts';
import { computeName, nearestLandmark } from './accessibility.js';
import { isVisible } from './observer.js';
import type { ElementRegistry } from './registry.js';

/**
 * Generic extraction (Phase 5). No selectors, no site code: an "item" is a visible link outside page
 * chrome together with the smallest card around it; a price is a currency amount in that card that
 * is not struck through. Works on product grids, search results and lists alike.
 */

export interface ParsedPrice {
  amount: number;
  currency: 'INR' | 'USD' | 'EUR' | 'GBP';
}

const CURRENCY: Record<string, ParsedPrice['currency']> = {
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

const PRICE_RE =
  /(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s?(?:k|lakh|lac|l|cr|crore)\b)?/i;

const MULTIPLIER: Record<string, number> = { k: 1e3, lakh: 1e5, lac: 1e5, l: 1e5, cr: 1e7, crore: 1e7 };

/** First currency amount in a text: "₹49,999", "Rs. 1,29,900", "$12.50", "₹1.2 lakh". */
export function parsePrice(text: string): ParsedPrice | null {
  const m = PRICE_RE.exec(text);
  if (!m) return null;
  const currency = CURRENCY[m[1]!.toLowerCase()];
  if (!currency) return null;
  let amount = Number(m[2]!.replace(/,/g, ''));
  const unit = m[3]?.trim().toLowerCase();
  if (unit) amount *= MULTIPLIER[unit] ?? 1;
  return Number.isFinite(amount) ? { amount, currency } : null;
}

const RATING_RE = /(\d(?:\.\d)?)\s*(?:★|\/\s*5|out of 5|stars?)/i;
const CHROME = new Set(['banner', 'navigation', 'contentinfo']);
const MAX_ITEMS = 100;

function struck(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (['del', 's', 'strike'].includes(e.localName)) return true;
    const style = e.ownerDocument.defaultView?.getComputedStyle(e);
    if (style?.textDecorationLine?.includes('line-through')) return true;
    if (e.localName === 'a' || e.localName === 'li' || e.localName === 'article') break;
  }
  return false;
}

/** Visible text of a card, skipping struck-through (old) prices. */
function cardPrice(card: Element): ParsedPrice | null {
  const walker = card.ownerDocument.createTreeWalker(card, 4 /* SHOW_TEXT */);
  let buffer = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || struck(parent)) continue;
    buffer += ` ${n.nodeValue ?? ''}`;
    const found = parsePrice(buffer.slice(-80));
    if (found) return found;
  }
  return null;
}

function hrefOf(el: Element): string | null {
  const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
  return (link as HTMLAnchorElement | null)?.href ?? null;
}

/** The smallest ancestor that looks like the link's own card: stops before a repeated-list parent. */
function cardOf(link: Element): Element {
  let card: Element = link;
  for (let i = 0; i < 6; i++) {
    const parent = card.parentElement;
    if (!parent || parent.localName === 'body' || parent.localName === 'main') break;
    // Parent holds a similar sibling that leads somewhere else → `card` is one entry of a list/grid.
    // (A sibling linking to the same place — an image link next to the title link — is the same card.)
    const own = hrefOf(card);
    const similar = Array.from(parent.children).some(
      (c) => c !== card && c.localName === card.localName && hrefOf(c) !== null && hrefOf(c) !== own,
    );
    if (similar) return card;
    if (parent.querySelectorAll('a[href]').length > 6) return card;
    card = parent;
  }
  return card;
}

export function extractItems(doc: Document, registry: ElementRegistry): ExtractedItem[] {
  const seen = new Map<string, number>();
  const items: ExtractedItem[] = [];
  for (const el of Array.from(doc.querySelectorAll('a[href]'))) {
    if (items.length >= MAX_ITEMS) break;
    const link = el as HTMLAnchorElement;
    const href = link.getAttribute('href') ?? '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    if (!isVisible(link)) continue;
    const landmark = nearestLandmark(link);
    if (landmark && CHROME.has(landmark)) continue;
    const key = link.href;
    const linkTitle = (computeName(link) ?? '').replace(/\s+/g, ' ').trim();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      // Same product linked twice (image, then title): the titled link is the better target.
      const item = items[earlier]!;
      if (!item.title && linkTitle.length >= 3) {
        items[earlier] = { ...item, elementId: registry.idFor(link), title: linkTitle.slice(0, 300) };
      }
      continue;
    }
    const card = cardOf(link);
    const title =
      linkTitle ||
      (card.querySelector('h1,h2,h3,h4,[role=heading]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (title.length < 3 && !link.querySelector('img')) continue;
    seen.set(key, items.length);
    const price = cardPrice(card);
    const rating = RATING_RE.exec(card.textContent ?? '');
    items.push({
      elementId: registry.idFor(link),
      title: title.slice(0, 300),
      price: price?.amount ?? null,
      currency: price?.currency ?? null,
      rating: rating ? Math.min(5, Number(rating[1])) : null,
      position: items.length + 1,
    });
  }
  // On a page with priced cards, unpriced links are navigation/filters: keep only the priced items.
  const priced = items.filter((i) => i.price !== null);
  const kept = priced.length >= 2 ? priced : items;
  return kept.map((item, i) => ({ ...item, position: i + 1 }));
}

const TEXT_BLOCKS = 'h1,h2,h3,p,li,blockquote,figcaption';

/** Main readable text: headings and paragraphs outside page chrome, bounded. */
/** Data tables (not layout tables): header row + body rows, bounded. */
export function extractTables(doc: Document): Array<{ headers: string[]; rows: string[][] }> {
  const out: Array<{ headers: string[]; rows: string[][] }> = [];
  const cell = (c: Element) => (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    if (out.length >= 10 || !isVisible(table)) continue;
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) continue;
    const first = rows[0]!;
    const headerCells = Array.from(first.querySelectorAll('th'));
    const headers = (headerCells.length ? headerCells : Array.from(first.children)).map(cell).slice(0, 30);
    const body = rows
      .slice(1)
      .map((r) => Array.from(r.querySelectorAll('td,th')).map(cell).slice(0, 30))
      .filter((r) => r.some(Boolean))
      .slice(0, 200);
    if (body.length) out.push({ headers, rows: body });
  }
  return out;
}

export function extractMainText(doc: Document): {
  title: string;
  headings: string[];
  paragraphs: string[];
  tables: Array<{ headers: string[]; rows: string[][] }>;
  truncated: boolean;
} {
  const root = doc.querySelector('main, article, [role=main]') ?? doc.body;
  const headings: string[] = [];
  const paragraphs: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const el of Array.from(root?.querySelectorAll(TEXT_BLOCKS) ?? [])) {
    const landmark = nearestLandmark(el);
    if (landmark && CHROME.has(landmark)) continue;
    if (!isVisible(el)) continue;
    // Skip containers whose text is repeated by a nested block.
    if (el.querySelector(TEXT_BLOCKS)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    if (chars + text.length > 20_000 || paragraphs.length >= 200) {
      truncated = true;
      break;
    }
    chars += text.length;
    if (/^h[1-3]$/.test(el.localName)) {
      if (headings.length < 40) headings.push(text.slice(0, 300));
    } else if (text.length >= 20) {
      paragraphs.push(text.slice(0, 2000));
    }
  }
  return { title: doc.title.slice(0, 512), headings, paragraphs, tables: extractTables(doc), truncated };
}

/** Scroll an element into view and report its viewport rectangle (for a trusted click). */
export function elementRect(
  el: Element | null,
): { visible: boolean; rect: { x: number; y: number; width: number; height: number } | null } {
  if (!el || !isVisible(el)) return { visible: false, rect: null };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  return { visible: r.width > 0 && r.height > 0, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
}
