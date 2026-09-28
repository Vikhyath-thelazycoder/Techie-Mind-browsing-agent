import {
  Domain,
  WebsiteResolution,
  type CandidateVerdict,
  type WebsiteProbe,
} from '@techie-mind/contracts';
import { tokenize } from './text.js';

/**
 * Generic website resolution (Phase 1 correction). Turns a name the user said ("Acme", "Blue Lotus
 * Spencer") into a website WITHOUT a search engine and WITHOUT a brand list:
 *
 *   1. derive domain labels from the name and form candidates over common TLDs;
 *   2. the host fetches each candidate (no cookies) and returns status, final URL and page head;
 *   3. every candidate is scored from evidence only — the page names itself after the brand, the
 *      final host is named after it, several candidates redirect to the same site, a sibling page
 *      says "we moved to X"; parked/for-sale/default-hosting pages and redirects to unrelated
 *      domains are rejected;
 *   4. candidates are grouped by the site they end up on; the strongest group wins. Two verified
 *      sites with near-equal evidence are reported as ambiguous instead of guessed.
 */

/** TLDs tried for every name, in preference order. India-first ccTLDs are always included. */
export const CANDIDATE_TLDS = ['com', 'in', 'co.in', 'org', 'net', 'io', 'co'] as const;
const REGION_TLDS: Record<string, readonly string[]> = {
  GB: ['co.uk'],
  AU: ['com.au'],
  CA: ['ca'],
  DE: ['de'],
  FR: ['fr'],
  JP: ['jp', 'co.jp'],
  SG: ['sg', 'com.sg'],
  AE: ['ae'],
  US: ['us'],
};
const MAX_CANDIDATES = 10;

/** Public suffixes with two labels that matter for registrable-domain grouping. */
const TWO_LEVEL_SUFFIXES = new Set([
  'co.in',
  'net.in',
  'org.in',
  'firm.in',
  'gen.in',
  'ind.in',
  'ac.in',
  'edu.in',
  'gov.in',
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'com.br',
  'com.sg',
  'com.my',
  'co.za',
  'com.mx',
  'com.cn',
  'com.hk',
  'com.tr',
  'co.kr',
  'com.ar',
  'co.id',
  'com.pk',
  'com.bd',
  'com.np',
  'com.lk',
]);

/** "www.shop.example.co.in" → "example.co.in". */
export function registrableDomain(host: string): string {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\d*\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  return parts.slice(TWO_LEVEL_SUFFIXES.has(lastTwo) ? -3 : -2).join('.');
}

/** The name part of a registrable domain: "example.co.in" → "example". */
export function domainLabel(domain: string): string {
  return registrableDomain(domain).split('.')[0] ?? '';
}

export interface BrandLabels {
  tokens: string[];
  /** Letters/digits only: "marksandspencer". */
  joined: string;
  /** Hyphenated multi-word form: "marks-and-spencer" (null for one word). */
  hyphen: string | null;
}

/** Domain labels for a spoken/typed name, or null when the name cannot form a hostname. */
export function brandLabels(name: string): BrandLabels | null {
  const tokens = tokenize(name.replace(/['’]/g, '').replace(/&/g, ' and '));
  if (tokens.length === 0 || tokens.length > 5) return null;
  if (!tokens.every((t) => /^[a-z0-9]+$/.test(t))) return null;
  const joined = tokens.join('');
  if (joined.length < 2 || joined.length > 40) return null;
  return { tokens, joined, hyphen: tokens.length > 1 ? tokens.join('-') : null };
}

/** Candidate domains for a name, most likely first (bounded). */
export function websiteCandidates(name: string, region: string | null): string[] {
  const labels = brandLabels(name);
  if (!labels) return [];
  const tlds = [...CANDIDATE_TLDS, ...(region ? (REGION_TLDS[region.toUpperCase()] ?? []) : [])];
  const out = tlds.map((tld) => `${labels.joined}.${tld}`);
  if (labels.hyphen) out.push(`${labels.hyphen}.com`, `${labels.hyphen}.in`);
  return [...new Set(out)].filter((d) => Domain.safeParse(d).success).slice(0, MAX_CANDIDATES);
}

// ── page identity (regex-level HTML reading: runs in a service worker without a DOM) ─────────

export interface PageIdentity {
  title: string;
  siteName: string;
  appName: string;
  ogTitle: string;
  refreshUrl: string | null;
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
}

function metaAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) {
    attrs[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

export function extractIdentity(html: string, baseUrl: string | null): PageIdentity {
  const head = html.slice(0, 300_000);
  const title = decodeEntities(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(head)?.[1] ?? '');
  let siteName = '';
  let appName = '';
  let ogTitle = '';
  let refreshUrl: string | null = null;
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = metaAttributes(m[0]);
    const key = (a['property'] ?? a['name'] ?? '').toLowerCase();
    const content = decodeEntities(a['content'] ?? '');
    if (key === 'og:site_name') siteName ||= content;
    else if (key === 'application-name' || key === 'apple-mobile-web-app-title')
      appName ||= content;
    else if (key === 'og:title') ogTitle ||= content;
    if ((a['http-equiv'] ?? '').toLowerCase() === 'refresh') {
      const target = /url\s*=\s*['"]?([^'";]+)/i.exec(a['content'] ?? '')?.[1]?.trim();
      if (target) refreshUrl = absoluteWebUrl(target, baseUrl);
    }
  }
  const text = decodeEntities(
    head
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .slice(0, 20_000),
  ).slice(0, 3_000);
  return { title, siteName, appName, ogTitle, refreshUrl, text };
}

function absoluteWebUrl(target: string, base: string | null): string | null {
  try {
    const url = base ? new URL(target, base) : new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// ── scoring ────────────────────────────────────────────────────────────────────────────────

/** Pages that exist but are not a real site: parked, for sale, expired (checked in page text). */
const PLACEHOLDER =
  /domain (?:name )?(?:is |may be )?for sale|this (?:website|domain) is for sale|buy this domain|parked (?:free|domain|by)|domain parking|hugedomains|sedoparking|sedo domain|afternic|domain has expired|this domain (?:has been )?registered|account (?:has been )?suspended/i;
/** Weaker signals, trusted only in the page's own title/site name (real shops say "coming soon"). */
const PLACEHOLDER_HEADING =
  /make an offer|default (?:web )?page|web hosting by|welcome to nginx|it works!|apache2? [a-z ]*default page|index of \/|future home of|coming soon|under construction/i;

const OK = (s: number) => s >= 200 && s < 400;
/** Reachable but gated (bot walls, geo gates, auth): the site exists, identity unknown. */
const GATED = (s: number) => [401, 403, 405, 406, 429, 451, 503].includes(s) || s >= 500;

const DOMAIN_IN_TEXT = /(?<![\p{L}\p{N}@/.-])((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\p{L}\p{N}-])/giu;

interface Scored {
  domain: string;
  verdict: CandidateVerdict;
  score: number;
  finalDomain: string | null;
  finalUrl: string | null;
  evidence: string;
  endorses: string[];
}

function mentionsBrand(identity: string, labels: BrandLabels): boolean {
  if (!identity) return false;
  const compact = identity.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (labels.joined.length >= 4 && compact.includes(labels.joined)) return true;
  const tokens = new Set(tokenize(identity));
  return labels.tokens.every((t) => tokens.has(t));
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function scoreProbe(domain: string, probe: WebsiteProbe | undefined, labels: BrandLabels): Scored {
  const base = { domain, finalDomain: null, finalUrl: null, endorses: [] as string[] };
  if (!probe || probe.error !== null || probe.status === null) {
    return {
      ...base,
      verdict: 'unreachable',
      score: 0,
      evidence: probe?.error ? `unreachable (${probe.error})` : 'not probed',
    };
  }
  const identity = extractIdentity(probe.body, probe.finalUrl ?? probe.url);
  const effectiveUrl = identity.refreshUrl ?? probe.finalUrl ?? probe.url;
  const host = hostOf(effectiveUrl);
  const finalDomain = host ? registrableDomain(host) : null;
  const scored = { ...base, finalDomain, finalUrl: effectiveUrl };
  const label = finalDomain ? domainLabel(finalDomain) : '';
  const heading = [identity.title, identity.siteName, identity.appName, identity.ogTitle]
    .filter(Boolean)
    .join(' · ');

  if (!finalDomain || !Domain.safeParse(finalDomain).success) {
    return { ...scored, verdict: 'rejected', score: 0, evidence: 'no usable final address' };
  }
  if (!label.includes(labels.joined) && !label.replace(/-/g, '').includes(labels.joined)) {
    return {
      ...scored,
      verdict: 'rejected',
      score: 0,
      evidence: `redirects to unrelated ${finalDomain}`,
    };
  }
  if (probe.status === 404 || probe.status === 410) {
    return { ...scored, verdict: 'rejected', score: 0, evidence: `HTTP ${probe.status}` };
  }
  if (PLACEHOLDER.test(`${heading} ${identity.text}`) || PLACEHOLDER_HEADING.test(heading)) {
    return {
      ...scored,
      verdict: 'rejected',
      score: 0,
      evidence: `placeholder page (${heading.slice(0, 60) || 'parked/for sale'})`,
    };
  }

  const endorses: string[] = [];
  for (const m of heading.matchAll(DOMAIN_IN_TEXT)) {
    const mentioned = registrableDomain(m[1] ?? '');
    if (mentioned !== finalDomain && domainLabel(mentioned).includes(labels.joined)) {
      endorses.push(mentioned);
    }
  }

  const ok = OK(probe.status);
  const gated = !ok && GATED(probe.status);
  const named = mentionsBrand(heading, labels);
  let score = label === labels.joined || label === labels.hyphen ? 2 : 1;
  const reasons = [label === labels.joined ? 'host named after it' : 'host contains the name'];
  if (named) {
    score += 4;
    reasons.push(`page names itself "${heading.slice(0, 50)}"`);
  }
  if (ok) {
    score += 1;
    reasons.push(`HTTP ${probe.status}`);
  } else if (gated) {
    reasons.push(`HTTP ${probe.status} (gated)`);
  }
  if (finalDomain !== registrableDomain(domain)) reasons.push(`→ ${finalDomain}`);
  const verdict: CandidateVerdict =
    named && ok ? 'verified' : ok || gated ? 'plausible' : 'rejected';
  return {
    ...scored,
    verdict,
    score: verdict === 'rejected' ? 0 : score,
    evidence: reasons.join(' · ').slice(0, 480),
    endorses,
  };
}

const RANK: Record<CandidateVerdict, number> = {
  verified: 2,
  plausible: 1,
  rejected: 0,
  unreachable: 0,
};

interface Group {
  domain: string;
  members: Scored[];
  score: number;
  verdict: CandidateVerdict;
  url: string;
}

/** Near-equal evidence between two verified sites: do not guess. */
const AMBIGUITY_MARGIN = 1.5;

/**
 * Decide a website from probe evidence. Pure: the same probes always give the same answer.
 * `probes` are matched to candidates by their requested URL (`https://<domain>/`).
 */
export function resolveWebsite(
  name: string,
  candidates: readonly string[],
  probes: readonly WebsiteProbe[],
  fromCache = false,
): WebsiteResolution {
  const labels = brandLabels(name);
  const safeName = name.slice(0, 80) || '?';
  if (!labels) {
    return WebsiteResolution.parse({
      name: safeName,
      chosen: null,
      ambiguous: false,
      fromCache,
      candidates: [],
    });
  }
  const byUrl = new Map(probes.map((p) => [p.url, p]));
  const scored = candidates.map((d) => scoreProbe(d, byUrl.get(`https://${d}/`), labels));

  const groups = new Map<string, Group>();
  for (const s of scored) {
    if (RANK[s.verdict] === 0 || !s.finalDomain || !s.finalUrl) continue;
    const g = groups.get(s.finalDomain) ?? {
      domain: s.finalDomain,
      members: [],
      score: 0,
      verdict: 'plausible' as CandidateVerdict,
      url: s.finalUrl,
    };
    g.members.push(s);
    groups.set(s.finalDomain, g);
  }
  const endorsements = scored.flatMap((s) => s.endorses);
  for (const g of groups.values()) {
    const best = [...g.members].sort((a, b) => b.score - a.score)[0]!;
    g.verdict = g.members.some((m) => m.verdict === 'verified') ? 'verified' : 'plausible';
    // Navigate to the address the site itself settled on (e.g. a regional home page).
    g.url = originOf(best.finalUrl) ?? `https://${g.domain}/`;
    g.score =
      best.score +
      2 * (g.members.length - 1) + // independent candidates converge on this site
      2 * endorsements.filter((e) => e === g.domain).length + // "X is now <this site>"
      (g.domain.endsWith('.com') ? 1.5 : 0);
  }
  const ranked = [...groups.values()].sort(
    (a, b) => b.score - a.score || RANK[b.verdict] - RANK[a.verdict],
  );
  const top = ranked[0];
  const second = ranked[1];
  const ambiguous =
    !!top &&
    !!second &&
    top.verdict === 'verified' &&
    second.verdict === 'verified' &&
    top.score - second.score < AMBIGUITY_MARGIN;

  return WebsiteResolution.parse({
    name: safeName,
    chosen: top ? { domain: top.domain, url: top.url } : null,
    ambiguous,
    fromCache,
    candidates: scored.map((s) => ({
      domain: s.domain,
      verdict: s.verdict,
      score: s.score,
      finalDomain: s.finalDomain,
      evidence: s.evidence.slice(0, 500),
    })),
  });
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Keep a regional path the site redirected to ("/in/") but drop queries and fragments.
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/** Alternatives worth naming when resolution is ambiguous. */
export function resolutionAlternatives(resolution: WebsiteResolution): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...resolution.candidates].sort((a, b) => b.score - a.score)) {
    if (c.verdict !== 'verified' || !c.finalDomain || seen.has(c.finalDomain)) continue;
    seen.add(c.finalDomain);
    out.push(c.finalDomain);
  }
  return out;
}

// ── in-memory cache (per background lifetime) ─────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, { at: number; resolution: WebsiteResolution }>();

export function cachedResolution(key: string, now: number): WebsiteResolution | null {
  const hit = cache.get(key);
  if (!hit || now - hit.at > CACHE_TTL_MS) return null;
  return { ...hit.resolution, fromCache: true };
}

export function cacheResolution(key: string, resolution: WebsiteResolution, now: number): void {
  if (!resolution.chosen || resolution.ambiguous) return;
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: now, resolution });
}

export function clearResolutionCache(): void {
  cache.clear();
}
