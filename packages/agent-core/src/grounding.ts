import { DERIVED_ATTR, type DOMNode, type Observation } from '@techie-mind/contracts';
import { countTerms, tokenize } from './text.js';

/**
 * Semantic target grounding (spec §11 level 3, master plan §14). Pure functions over a local
 * DOM/A11y observation: every candidate gets an explainable score from generic signals — role,
 * input type, accessible name, form semantics, landmark and geometry. There are no site-specific
 * selectors: the same code grounds YouTube, Flipkart or any other site.
 */

export interface Candidate {
  node: DOMNode;
  score: number;
  reasons: string[];
}

const SEARCH_WORDS = /(?:^|[^a-z])(search|find|query|look ?up|khoj|सर्च|ಹುಡುಕ)/i;
const SEARCH_NAMES = new Set([
  'q',
  'query',
  'search',
  'search_query',
  'searchterm',
  'keyword',
  'keywords',
  'k',
  's',
  'text',
]);
const NOT_SEARCH =
  /e-?mail|newsletter|subscribe|log ?in|sign ?in|sign ?up|password|user ?name|coupon|promo|voucher|pin ?code|zip|postal|otp|phone|mobile|card|cvv|comment|reply|message/i;
const EXCLUDED_INPUT_TYPES = new Set([
  'password',
  'email',
  'tel',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'hidden',
  'checkbox',
  'radio',
  'file',
  'submit',
  'button',
  'reset',
  'image',
  'range',
  'color',
]);
const CHROME_LANDMARKS = new Set(['banner', 'navigation', 'contentinfo']);
const NOT_SUBMIT =
  /clear|close|cancel|voice|mic(rophone)?|camera|image search|by image|lens|filter|back/i;

function attr(node: DOMNode, key: string): string {
  return node.attributes[key] ?? '';
}

/** All human/semantic labels of a node, lowercased, for keyword matching. */
function haystack(node: DOMNode): string {
  return [
    node.name,
    attr(node, 'placeholder'),
    attr(node, 'aria-label'),
    attr(node, 'title'),
    attr(node, 'id'),
    attr(node, 'name'),
    attr(node, 'class'),
    attr(node, 'autocomplete'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isSearchForm(node: DOMNode): boolean {
  return (
    attr(node, DERIVED_ATTR.formRole) === 'search' ||
    /search|query|find|results?/i.test(attr(node, DERIVED_ATTR.formAction))
  );
}

function isClickable(node: DOMNode): boolean {
  return node.interactive && !node.editable && node.visible;
}

function byScoreThenPosition(a: Candidate, b: Candidate): number {
  return b.score - a.score || (a.node.bbox?.y ?? 1e9) - (b.node.bbox?.y ?? 1e9);
}

/** Rank editable controls by how likely they are the page's primary search field. */
export function groundSearchInput(obs: Observation): Candidate[] {
  const out: Candidate[] = [];
  for (const node of obs.domNodes) {
    if (!node.editable || !node.visible) continue;
    if (node.inputType && EXCLUDED_INPUT_TYPES.has(node.inputType)) continue;
    const text = haystack(node);
    const reasons: string[] = [];
    let score = 0;
    if (node.inputType === 'search') {
      score += 4;
      reasons.push('type=search');
    }
    if (node.role === 'searchbox') {
      score += 4;
      reasons.push('role=searchbox');
    } else if (node.role === 'combobox') {
      score += 2;
      reasons.push('role=combobox');
    }
    if (SEARCH_WORDS.test(text)) {
      score += 4;
      reasons.push('search wording in label');
    }
    if (SEARCH_NAMES.has(attr(node, 'name').toLowerCase())) {
      score += 2;
      reasons.push(`name=${attr(node, 'name')}`);
    }
    if (isSearchForm(node)) {
      score += 3;
      reasons.push('inside search form');
    }
    const landmark = attr(node, DERIVED_ATTR.landmark);
    if (landmark === 'banner' || landmark === 'search' || landmark === 'navigation') {
      score += 1;
      reasons.push(`in ${landmark}`);
    }
    if (node.bbox && node.bbox.y < obs.viewport.height * 0.35) {
      score += 1;
      reasons.push('near top');
    }
    if (node.bbox && node.bbox.width >= 150) {
      score += 1;
      reasons.push('wide field');
    }
    if (NOT_SEARCH.test(text) || attr(node, 'autocomplete').includes('email')) {
      score -= 6;
      reasons.push('looks like a non-search field');
    }
    if (score >= 4) out.push({ node, score, reasons });
  }
  return out.sort(byScoreThenPosition);
}

/** Buttons that submit the search field's query (same form, search label, or adjacent). */
export function groundSearchSubmit(obs: Observation, input: DOMNode): Candidate[] {
  const out: Candidate[] = [];
  for (const node of obs.domNodes) {
    if (node.nodeId === input.nodeId || !isClickable(node)) continue;
    const isButtonish =
      node.role === 'button' ||
      node.tag === 'button' ||
      node.inputType === 'submit' ||
      node.inputType === 'image';
    if (!isButtonish) continue;
    const text = haystack(node) + ' ' + (node.text ?? '').toLowerCase();
    // Controls that sit next to a search box but never submit it.
    if (NOT_SUBMIT.test(text)) continue;
    const reasons: string[] = [];
    let score = 0;
    if (input.formId && node.formId === input.formId) {
      score += 4;
      reasons.push('same form as field');
    }
    if (node.inputType === 'submit' || attr(node, 'type') === 'submit') {
      score += 2;
      reasons.push('type=submit');
    }
    if (SEARCH_WORDS.test(text) || /(^|\s)(go|submit)(\s|$)/i.test(text)) {
      score += 3;
      reasons.push('search/go label');
    }
    if (node.bbox && input.bbox) {
      const dx = node.bbox.x - (input.bbox.x + input.bbox.width);
      const verticalOverlap =
        Math.min(node.bbox.y + node.bbox.height, input.bbox.y + input.bbox.height) -
        Math.max(node.bbox.y, input.bbox.y);
      if (dx > -40 && dx < 160 && verticalOverlap > 0) {
        score += 2;
        reasons.push('adjacent to field');
      }
    }
    if (score >= 3) out.push({ node, score, reasons });
  }
  return out.sort(byScoreThenPosition);
}

/** A control that reveals a collapsed search UI (icon button labelled "search"). */
export function groundSearchToggle(obs: Observation): Candidate[] {
  const out: Candidate[] = [];
  for (const node of obs.domNodes) {
    if (!isClickable(node)) continue;
    if (!(node.role === 'button' || node.role === 'link' || node.tag === 'button')) continue;
    const text = `${haystack(node)} ${(node.text ?? '').toLowerCase()}`;
    if (!SEARCH_WORDS.test(text)) continue;
    const reasons = ['search wording on a button'];
    let score = 4;
    if (node.bbox && node.bbox.y < obs.viewport.height * 0.35) {
      score += 1;
      reasons.push('near top');
    }
    if (/advanced|history|voice|image/i.test(text)) score -= 3;
    if (score >= 4) out.push({ node, score, reasons });
  }
  return out.sort(byScoreThenPosition);
}

export interface ResultCandidate extends Candidate {
  matchedTerms: number;
}

/**
 * Result links for a query: visible links outside page chrome (header/nav/footer) whose text
 * shares terms with the query. Used both to verify a search and to open/play a result.
 */
export function groundResults(obs: Observation, query: string): ResultCandidate[] {
  const terms = [...new Set(tokenize(query))];
  const out: ResultCandidate[] = [];
  for (const node of obs.domNodes) {
    if (node.role !== 'link' || !node.visible) continue;
    const href = attr(node, 'href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    if (CHROME_LANDMARKS.has(attr(node, DERIVED_ATTR.landmark))) continue;
    // Links usually expose the same string as name and text: use the longer, never both.
    const label = [node.name ?? '', node.text ?? ''].sort((a, b) => b.length - a.length)[0]!.trim();
    if (label.length < 8) continue;
    const matchedTerms = countTerms(label, terms);
    if (matchedTerms === 0) continue;
    const reasons = [`${matchedTerms}/${terms.length} query terms`];
    let score = matchedTerms * 3;
    if (matchedTerms === terms.length) {
      score += 3;
      reasons.push('all terms');
    }
    if (label.length >= 20) {
      score += 1;
      reasons.push('descriptive title');
    }
    if (node.bbox && node.bbox.width * node.bbox.height > 2_000) {
      score += 1;
      reasons.push('prominent');
    }
    score += itemPenalty(href, label, reasons);
    out.push({ node, score, reasons, matchedTerms });
  }
  return out.sort(byScoreThenPosition);
}

/** Short human description of a grounded node for timelines and reports. */
export function describeNode(node: DOMNode): string {
  const label = node.name || attr(node, 'placeholder') || node.text || '';
  return `${node.role ?? node.tag} "${label.slice(0, 60)}"`;
}

/**
 * The query the open page is showing results for, read from its own search field — how a follow-up
 * command ("play the first one") knows what the results are about without remembering anything.
 */
export function currentQuery(obs: Observation): string | null {
  const value = groundSearchInput(obs)[0]?.node.value?.trim();
  return value ? value.slice(0, 512) : null;
}

/**
 * Result-like links when no query is known: descriptive, visible links outside page chrome.
 * Weaker than query-matched results, used only for follow-ups on pages without a search field.
 */
export function groundListLinks(obs: Observation): ResultCandidate[] {
  const out: ResultCandidate[] = [];
  for (const node of obs.domNodes) {
    if (node.role !== 'link' || !node.visible || !node.bbox) continue;
    const href = attr(node, 'href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) continue;
    if (CHROME_LANDMARKS.has(attr(node, DERIVED_ATTR.landmark))) continue;
    const label = [node.name ?? '', node.text ?? ''].sort((a, b) => b.length - a.length)[0]!.trim();
    if (label.length < 15) continue;
    const reasons = ['descriptive link in main content'];
    let score = 1;
    if (label.length >= 25) score += 1;
    if (node.bbox.width * node.bbox.height > 2_000) {
      score += 1;
      reasons.push('prominent');
    }
    score += itemPenalty(href, label, reasons);
    out.push({ node, score, reasons, matchedTerms: 0 });
  }
  return out.sort(byScoreThenPosition);
}

/**
 * Generic URL shapes of profile / channel / author pages (a person or channel, not an item), and
 * labels of sponsored placements. A result that is one of these is ranked below real items — seen
 * live: a channel named after the query outranked the videos.
 */
const PROFILE_PATH =
  /^\/(?:@[^/]+\/?$|(?:channel|c|user|profile|profiles|author|authors|creator|people)\/)/i;
const SPONSORED_LABEL = /^(?:sponsored|ad|advertisement|promoted)\b|\b(?:sponsored|promoted)$/i;

function itemPenalty(href: string, label: string, reasons: string[]): number {
  let penalty = 0;
  let path = href;
  try {
    path = new URL(href, 'https://x.invalid/').pathname;
  } catch {
    // keep the raw href
  }
  if (PROFILE_PATH.test(path)) {
    penalty -= 6;
    reasons.push('profile/channel page, not an item');
  }
  if (SPONSORED_LABEL.test(label.trim())) {
    penalty -= 3;
    reasons.push('sponsored placement');
  }
  return penalty;
}

function byPosition(a: Candidate, b: Candidate): number {
  const ay = a.node.bbox?.y ?? 1e9;
  const by = b.node.bbox?.y ?? 1e9;
  // Same visual row (±8px): left to right; otherwise top to bottom.
  return Math.abs(ay - by) > 8 ? ay - by : (a.node.bbox?.x ?? 0) - (b.node.bbox?.x ?? 0);
}

/**
 * Results in the order they should be tried. `ordinal` null: best match first. `ordinal` n: the
 * n-th relevant result in reading order (top→bottom, left→right), duplicates of the same
 * destination collapsed, then the rest as fallbacks.
 */
export function rankResults(
  obs: Observation,
  query: string | null,
  ordinal: number | null,
): ResultCandidate[] {
  const all = query ? groundResults(obs, query) : groundListLinks(obs);
  if (ordinal === null) return all;
  // Relevant = at least half as many query terms as the best match (all links when no query).
  const best = Math.max(0, ...all.map((c) => c.matchedTerms));
  const strong = all.filter((c) => c.matchedTerms >= Math.ceil(best / 2));
  const seen = new Set<string>();
  const ordered = [...strong].sort(byPosition).filter((c) => {
    const key = attr(c.node, 'href');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chosen = ordered[ordinal - 1];
  if (!chosen) return [];
  chosen.reasons.push(`result #${ordinal} in reading order`);
  return [chosen, ...ordered.slice(ordinal), ...ordered.slice(0, ordinal - 1)];
}
