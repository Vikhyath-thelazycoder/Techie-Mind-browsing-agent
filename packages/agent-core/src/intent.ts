import { canonicalize } from './multilingual.js';
import {
  Domain,
  IntentProfile,
  type Constraint,
  type Language,
  type SkillId,
} from '@techie-mind/contracts';
import { KNOWN_SITES, siteForDomain, type SiteEntry } from './sites.js';
import { escapeRegExp, normalize } from './text.js';
import { detectSkill, SKILL_ARG_ENTITY, SKILL_ENTITY } from './skills.js';

/**
 * Tier-0 deterministic intent resolver (spec §7–8, §18). No model is called.
 *
 * It works on clause structure, never on whole sentences:
 *   1. find the site the user named (known alias or explicit domain),
 *   2. pull out constraints (price bounds),
 *   3. find the primary command verb (play / search / open) in English, Hinglish or romanised Kannada,
 *   4. take the query from the side of the verb that holds it (after it for English order,
 *      before it for postfix forms such as "… search maadu"),
 *   5. strip the site mention, its prepositions/postpositions and edge filler words.
 */

// ── vocabulary ─────────────────────────────────────────────────────────────────────────────────

/** Postfix (verb-final) command forms used in Hindi/Kannada code-switching. */
const PLAY_POSTFIX = [
  'play maadi',
  'play madi',
  'play maadu',
  'play karo',
  'bajao',
  'chalao',
  'haaku',
];
const SEARCH_POSTFIX = [
  'search maadi',
  'search madi',
  'search maadu',
  'search karo',
  'dhoondo',
  'dhundo',
  'khojo',
  'huduku',
  'hudukku',
];
const PLAY_PREFIX = ['play', 'stream', 'listen to', 'watch'];
const SEARCH_PREFIX = ['search for', 'search', 'look up', 'look for', 'find me', 'find', 'show me'];
const NAV_VERBS = [
  'open up',
  'open',
  'go to',
  'goto',
  'go on',
  'visit',
  'navigate to',
  'head to',
  'head over to',
  'switch to',
  'launch',
  'take me to',
  'bring up',
  'pull up',
];
/** Clause-final navigation verbs (Hindi/Kannada code-switching): "Acme website kholo". */
const NAV_POSTFIX = [
  'kholo',
  'khol do',
  'kholiye',
  'open karo',
  'open kar do',
  'open kariye',
  'open maadi',
  'open madi',
  'open maadu',
  'open madu',
];
const PURCHASE_VERBS = ['buy', 'purchase', 'order', 'checkout', 'check out', 'pay for'];

/** Words attached to a site mention that are not part of the query. */
const SITE_PREFIXES = ['on', 'in', 'at', 'from', 'using', 'via', 'inside', 'within'];
const SITE_SUFFIXES = [
  'website',
  'site',
  'app',
  'pe',
  'par',
  'me',
  'mein',
  'alli',
  'nalli',
  'dalli',
  'lli',
];

/** Filler removed only at the edges of the extracted query. */
const EDGE_FILLER = new Set([
  'for',
  'some',
  'a few',
  'few',
  'me',
  'and',
  'then',
  'please',
  'pls',
  'to',
  'on',
  'in',
  'the site',
  'it',
  'about',
  'any',
  'kuch',
  'swalpa',
]);

const POLITE = [
  'can you please',
  'could you please',
  'can you',
  'could you',
  'would you',
  'please',
  'kindly',
  'i want to',
  "i'd like to",
  'i would like to',
  "let's",
  'lets',
  'hey',
  'techie mind',
];

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
}

function phraseRegex(phrases: readonly string[]): RegExp {
  const sorted = [...phrases].sort((a, b) => b.length - a.length).map(escapeRegExp);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${sorted.join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

const PLAY_POSTFIX_RE = phraseRegex(PLAY_POSTFIX);
const SEARCH_POSTFIX_RE = phraseRegex(SEARCH_POSTFIX);
const PLAY_PREFIX_RE = phraseRegex(PLAY_PREFIX);
const SEARCH_PREFIX_RE = phraseRegex(SEARCH_PREFIX);
const NAV_RE = phraseRegex(NAV_VERBS);
const NAV_POSTFIX_RE = phraseRegex(NAV_POSTFIX);
const PURCHASE_RE = phraseRegex(PURCHASE_VERBS);
const POLITE_RE = phraseRegex(POLITE);

/** Explicit domain such as "example.com" or "shop.fixture.test" (not "2.5" or "e.g"). */
const DOMAIN_RE =
  /(?<![\p{L}\p{N}@/.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\p{L}\p{N}-])/gu;

function firstMatch(re: RegExp, text: string): (Span & { text: string }) | null {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null;
}

function squash(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .trim();
}

interface SiteMention extends Span {
  site: SiteEntry | null;
  domain: string;
}

/**
 * Precedence: an explicit domain of a known site ("youtube.com") > a known alias ("youtube") >
 * any other explicit domain ("shop.fixture.test"). This keeps domain-shaped query words such as
 * "node.js" from hijacking routing when a real site is named.
 */
function findSiteMention(text: string): SiteMention | null {
  const explicit: SiteMention[] = [];
  DOMAIN_RE.lastIndex = 0;
  for (let m = DOMAIN_RE.exec(text); m; m = DOMAIN_RE.exec(text)) {
    const domain = (m[1] ?? '').replace(/^www\./, '');
    if (!Domain.safeParse(domain).success) continue;
    explicit.push({
      start: m.index,
      end: m.index + m[0].length,
      site: siteForDomain(domain) ?? null,
      domain,
    });
  }
  const knownExplicit = explicit.find((e) => e.site !== null);
  if (knownExplicit) return knownExplicit;

  let alias: SiteMention | null = null;
  for (const site of KNOWN_SITES) {
    for (const name of site.aliases) {
      const m = firstMatch(phraseRegex([name]), text);
      if (!m) continue;
      const better =
        !alias || m.start < alias.start || (m.start === alias.start && m.end > alias.end);
      if (better) alias = { start: m.start, end: m.end, site, domain: site.domain };
    }
  }
  return alias ?? explicit[0] ?? null;
}

/** Remove the site mention together with its attached prepositions/postpositions. */
function removeSiteMention(text: string, mention: SiteMention | null): string {
  if (!mention) return text;
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const prefix = new RegExp(`(?:^|\\s)(?:${SITE_PREFIXES.join('|')})(?:\\s+the)?\\s*$`, 'u');
  const suffix = new RegExp(
    `^\\s*(?:\\.com|\\.in)?(?:\\s+(?:${SITE_SUFFIXES.join('|')}))*(?=\\s|$|[,;])`,
    'u',
  );
  return `${before.replace(prefix, ' ')} ${after.replace(suffix, ' ')}`;
}

// ── constraints ────────────────────────────────────────────────────────────────────────────────

const CURRENCY = '(?:₹|rs\\.?|inr|rupees?)';
const PRICE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(under|below|less than|within|upto|up to|max(?:imum)?|cheaper than|above|over|more than|at least|min(?:imum)?)\\s*${CURRENCY}?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(k|thousand|lakhs?)?\\s*(${CURRENCY})?`,
  'giu',
);

function extractConstraints(text: string): { constraints: Constraint[]; rest: string } {
  const constraints: Constraint[] = [];
  const rest = text.replace(PRICE_RE, (full, word: string, num: string, mult?: string) => {
    let value = Number(num.replace(/,/g, ''));
    if (!Number.isFinite(value)) return full;
    if (mult === 'k' || mult === 'thousand') value *= 1_000;
    if (mult?.startsWith('lakh')) value *= 100_000;
    const upper = /under|below|less|within|upto|up to|max|cheaper/.test(word);
    const hasCurrency = new RegExp(CURRENCY, 'iu').test(full);
    constraints.push({
      field: 'price',
      op: upper ? '<=' : '>=',
      value,
      unit: hasCurrency ? 'INR' : null,
    });
    return ' ';
  });
  return { constraints, rest };
}

// ── language ───────────────────────────────────────────────────────────────────────────────────

const KANNADA_WORDS =
  /(?<![\p{L}])(maadi|maadu|madi|alli|nalli|huduku|hudukku|haaku|beku|swalpa)(?![\p{L}])/u;
const HINDI_WORDS =
  /(?<![\p{L}])(pe|par|mein|dhoondo|dhundo|khojo|chalao|bajao|kholo|gaane|karo|kuch)(?![\p{L}])/u;

export function detectLanguage(original: string): Language {
  if (/[ಀ-೿]/u.test(original)) return 'kn';
  if (/[ऀ-ॿ]/u.test(original)) return 'hi';
  if (/[஀-௿]/u.test(original)) return 'ta';
  if (/[ఀ-౿]/u.test(original)) return 'te';
  const text = normalize(original);
  if (KANNADA_WORDS.test(text)) return 'mixed';
  if (HINDI_WORDS.test(text)) return 'hinglish';
  return 'en';
}

// ── query extraction ───────────────────────────────────────────────────────────────────────────

function trimEdges(query: string): string {
  let q = squash(query.replace(/^[\s,;:"'-]+|[\s,;:"'-]+$/g, ''));
  let changed = true;
  while (changed && q.length > 0) {
    changed = false;
    for (const filler of EDGE_FILLER) {
      if (q === filler) return '';
      if (q.startsWith(`${filler} `)) {
        q = q.slice(filler.length + 1).trim();
        changed = true;
      }
      if (q.endsWith(` ${filler}`)) {
        q = q.slice(0, -filler.length - 1).trim();
        changed = true;
      }
    }
    q = q.replace(/^[,;:"'-]+|[,;:"'-]+$/g, '').trim();
    // A leading article is never part of what to search for ("play a Kannada song").
    const article = /^(?:a|an)\s+(?=\S)/u.exec(q);
    if (article) {
      q = q.slice(article[0].length);
      changed = true;
    }
  }
  return q;
}

type Command = 'play' | 'search' | 'purchase';

interface CommandMatch extends Span {
  command: Command;
  postfix: boolean;
}

function findCommand(text: string): CommandMatch | null {
  const candidates: CommandMatch[] = [];
  const push = (re: RegExp, command: Command, postfix: boolean) => {
    const m = firstMatch(re, text);
    if (m) candidates.push({ start: m.start, end: m.end, command, postfix });
  };
  push(PLAY_POSTFIX_RE, 'play', true);
  push(SEARCH_POSTFIX_RE, 'search', true);
  push(PLAY_PREFIX_RE, 'play', false);
  push(SEARCH_PREFIX_RE, 'search', false);
  push(PURCHASE_RE, 'purchase', false);
  if (candidates.length === 0) return null;
  // Postfix forms are only commands when they end the clause ("… search maadu").
  const valid = candidates.filter(
    (c) => !c.postfix || text.slice(c.end).replace(/[\s,;]+/g, '') === '',
  );
  if (valid.length === 0) return null;
  // Earliest command wins; on a tie prefer the longer phrase ("search for" over "search").
  valid.sort((a, b) => a.start - b.start || b.end - a.end);
  return valid[0] ?? null;
}

/**
 * Matching runs on lowercased text, but the agent should type what the user wrote
 * ("Carnatic Violin", not "carnatic violin"). Find the query in the original (case-preserved) text.
 */
function restoreCase(original: string, query: string): string {
  if (!query) return query;
  const cased = original
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ');
  const match = new RegExp(escapeRegExp(query).replace(/\\ /g, '\\s+'), 'iu').exec(cased);
  return match && match[0].toLowerCase() === query ? match[0] : query;
}

function stripQuotes(text: string): string | null {
  const m = /"([^"]{1,200})"|'([^']{1,200})'/.exec(text);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

// ── current-context language ───────────────────────────────────────────────────────────────

/** "in the current tab", "on this page", "this website", "same tab" … (explicit CURRENT_TAB). */
const CONTEXT_RE =
  /(?<![\p{L}\p{N}])(?:(?:in|on|within|inside|using|from|at)\s+)?(?:the\s+)?(?:current(?:ly)?(?:\s+open(?:ed)?)?|this|same|present|opened|existing)\s+(?:tab|page|web\s?page|website|web\s?site|site|window)(?:\s+itself)?(?![\p{L}\p{N}])/gu;
/** Other explicit forms: "right here", "continue here", Hinglish "isi tab mein", Kannada "ee tab alli". */
const CONTEXT_WORDS_RE =
  /(?<![\p{L}\p{N}])(?:right here|here itself|continue here|isi (?:tab|page)(?:\s+(?:mein|me|par|pe))?|ee (?:tab|page)(?:\s*(?:alli|nalli))?|yahin(?: par| pe)?|illi)(?![\p{L}\p{N}])/gu;
/** Bare "here" only where it cannot be part of a query: right after the verb, or ending the request. */
const HERE_AFTER_VERB_RE =
  /(?<![\p{L}\p{N}])(search for|search|find|look up|look for|play|continue)\s+here(?=\s*(?:$|,|\bfor\b|\band\b))/gu;
const HERE_AT_EDGE_RE = /(?:^|(?<=[\s,]))here(?:\s*,)?(?=\s*(?:$|,))|^here\s*,\s*/gu;

function stripContext(text: string): { text: string; found: boolean } {
  let found = false;
  const mark = () => {
    found = true;
    return ' ';
  };
  let out = text.replace(CONTEXT_RE, mark).replace(CONTEXT_WORDS_RE, mark);
  out = out.replace(HERE_AFTER_VERB_RE, (_m, verb: string) => {
    found = true;
    return verb;
  });
  out = out.replace(HERE_AT_EDGE_RE, mark);
  // Leftover connectives from "in the current tab, search …" / "continue here and search …".
  out = squash(out)
    .replace(/^(?:and|then|,)\s+/u, '')
    .replace(/^continue\s+(?:and\s+)?/u, '');
  return { text: squash(out), found };
}

// ── references to results ("the first one", "play one", "pehla wala") ──────────────────────

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  '1st': 1,
  top: 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  fifth: 5,
  '5th': 5,
  pehla: 1,
  pehli: 1,
  pehle: 1,
  doosra: 2,
  dusra: 2,
  doosri: 2,
  teesra: 3,
  modala: 1,
  modalane: 1,
  modaladu: 1,
  eradane: 2,
  moorane: 3,
};
const REF_NOUNS = new Set([
  'one',
  'result',
  'video',
  'song',
  'link',
  'item',
  'option',
  'track',
  'product',
  'entry',
  'wala',
  'wali',
  'vala',
  'vali',
]);
const REF_TAIL =
  /\s+(?:of|from|in|on)\s+(?:them|these|those|the (?:list|results?|page|search results?))$/u;
const REF_VERBS_MEDIA = ['play', 'watch', 'stream', 'listen to', 'start'];
const REF_VERBS_OPEN = ['open', 'click on', 'click', 'select', 'choose', 'pick', 'go to'];
const REF_POSTFIX_MEDIA = [...PLAY_POSTFIX];
const REF_POSTFIX_OPEN = ['open karo', 'open maadi', 'open madi', 'kholo', 'click karo'];

export interface ResultReference {
  media: boolean;
  /** 1-based position; null = the best match ("play one", "play it"). */
  ordinal: number | null;
}

/** Does `phrase` refer to an item of the current results ("the first one", "it", "any song")? */
function parseReference(phrase: string, anyNoun = false): { ordinal: number | null } | null {
  let t = squash(phrase.replace(/[,.;]+$/u, '')).replace(REF_TAIL, '');
  if (/^(?:it|that|this one|that one|any|any one|anyone|one of them)$/u.test(t)) {
    return { ordinal: null };
  }
  t = t.replace(/^(?:the|a|an|any)\s+/u, '');
  const words = t.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  let ordinal: number | null = null;
  let i = 0;
  const first = words[0] ?? '';
  if (first in ORDINAL_WORDS) {
    ordinal = ORDINAL_WORDS[first] ?? null;
    i = 1;
  } else if (/^\d{1,2}(?:st|nd|rd|th)$/u.test(first)) {
    ordinal = Number.parseInt(first, 10);
    i = 1;
  }
  const rest = words.slice(i);
  // "click the second iphone": with a position and a click/open verb, the words after the ordinal
  // only describe the item. For playback they may be a title ("play first aid kit"), so not there.
  const nounOk = (anyNoun && ordinal !== null) || rest.every((w) => REF_NOUNS.has(foldPlural(w)));
  if (!nounOk || rest.length > 2) return null;
  if (ordinal === null && rest.length === 0) return null;
  if (ordinal !== null && (ordinal < 1 || ordinal > 50)) return null;
  return { ordinal };
}

function foldPlural(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

const REF_PREFIX_RE = new RegExp(
  `^(${[...REF_VERBS_MEDIA, ...REF_VERBS_OPEN]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})\\s+(.+)$`,
  'u',
);
const REF_POSTFIX_RE = new RegExp(
  `^(.+?)\\s+(${[...REF_POSTFIX_MEDIA, ...REF_POSTFIX_OPEN]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')})$`,
  'u',
);

/** A whole clause that only refers to a result: "play the first result", "pehla wala chalao". */
function clauseReference(clause: string): ResultReference | null {
  const c = squash(clause);
  const pre = REF_PREFIX_RE.exec(c);
  if (pre) {
    const media = REF_VERBS_MEDIA.includes(pre[1] ?? '');
    const ref = parseReference(pre[2] ?? '', !media);
    if (ref) return { media, ...ref };
  }
  const post = REF_POSTFIX_RE.exec(c);
  if (post) {
    const ref = parseReference(post[1] ?? '', REF_POSTFIX_OPEN.includes(post[2] ?? ''));
    if (ref) return { media: REF_POSTFIX_MEDIA.includes(post[2] ?? ''), ...ref };
  }
  return null;
}

const CONJUNCTION_RE =
  /(?:\s*,\s*(?:and\s+)?(?:then\s+)?|\s+(?:and then|and|then|aur phir|aur|phir|mattu|matte|&)\s+)/gu;

/** Split "search X and play the first one" into the main clause and a result reference. */
function splitFollowUp(text: string): { main: string; followUp: ResultReference | null } {
  CONJUNCTION_RE.lastIndex = 0;
  for (let m = CONJUNCTION_RE.exec(text); m; m = CONJUNCTION_RE.exec(text)) {
    const ref = clauseReference(text.slice(m.index + m[0].length));
    if (ref && m.index > 0) return { main: text.slice(0, m.index), followUp: ref };
  }
  return { main: text, followUp: null };
}

// ── website names that are not known sites ("open Acme", "Acme website kholo") ──────────

const NAME_SUFFIX_RE =
  /(?:'s)?(?:\s+(?:official|online|web|home))*(?:\s+(?:website|web site|site|app|homepage|home page|page|store|shop|portal))+$/u;
const NOT_A_SITE = new Set([
  'it',
  'this',
  'that',
  'them',
  'here',
  'there',
  'tab',
  'tabs',
  'a tab',
  'new tab',
  'a new tab',
  'window',
  'new window',
  'settings',
  'history',
  'downloads',
  'bookmarks',
  'extensions',
  'link',
  'file',
  'menu',
  'cart',
  'account',
  'profile',
  'inbox',
  'notifications',
  'home',
  'homepage',
  'website',
  'site',
  'page',
]);
const MAX_NAME_WORDS = 4;

/** Validate and clean a candidate website name; returns null when it cannot be a site name. */
function cleanSiteName(segment: string): string | null {
  let name = squash(segment.replace(/^[\s,;:"'-]+|[\s,;:"'-]+$/gu, ''))
    .replace(/\s+(?:and|then|aur|phir|mattu)$/u, '')
    .replace(/^(?:the|a|an)\s+/u, '')
    .replace(/^(?:official\s+)/u, '')
    .replace(NAME_SUFFIX_RE, '')
    .replace(/'s$/u, '')
    .trim();
  name = trimEdges(name);
  if (!name || NOT_A_SITE.has(name)) return null;
  if (/^(?:my|your|our|his|her|their)\s/u.test(name)) return null;
  const words = name.split(' ');
  if (words.length > MAX_NAME_WORDS || name.length > 40) return null;
  if (!/\p{L}/u.test(name)) return null;
  // A name never contains another command.
  if (firstMatch(SEARCH_PREFIX_RE, name) || firstMatch(PLAY_PREFIX_RE, name)) return null;
  return name;
}

function isCapitalisedIn(original: string, name: string): boolean {
  const m = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(name).replace(/\\ /g, '\\s+')}`,
    'iu',
  ).exec(original);
  if (!m) return false;
  return m[0].split(/\s+/).every((w) => /^[\p{Lu}\p{N}]/u.test(w));
}

interface NamedSite {
  name: string;
  /** Text with the name mention removed, when it sits inside a query segment. */
  query?: string;
}

/**
 * Find a website name that is not a known site or domain:
 *   "open Acme", "take me to the Acme website", "Acme kholo"                    (navigation)
 *   "open Acme and search for blue mugs"                                     (nav + command)
 *   "on Acme, search for blue mugs" / "search for blue mugs on Acme"      (preposition)
 *   "Acme pe blue mugs dhoondo"                                              (postposition)
 */
function findSiteName(
  text: string,
  original: string,
  command: CommandMatch | null,
  query: string,
): NamedSite | null {
  const postNav = firstMatch(NAV_POSTFIX_RE, text);
  if (postNav && !command && text.slice(postNav.end).trim() === '') {
    const name = cleanSiteName(text.slice(0, postNav.start));
    return name ? { name } : null;
  }
  const nav = firstMatch(NAV_RE, text);
  if (nav && (!command || nav.end <= command.start)) {
    const segment = command ? text.slice(nav.end, command.start) : text.slice(nav.end);
    const name = cleanSiteName(segment);
    if (name) return { name };
  }
  if (command && !command.postfix) {
    // Leading clause: "on Acme, search for …" / "on the Acme website search for …"
    const lead = /^(?:on|at|in)\s+(.+?)\s*,?\s*$/u.exec(text.slice(0, command.start));
    if (lead) {
      const name = cleanSiteName(lead[1] ?? '');
      if (name) return { name };
    }
    // Trailing: "… blue mugs on Acme" / "… on the acme website"
    const trail =
      /\s(?:on|at|from|in)\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}&'.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}&'.-]*){0,2}?)(\s+(?:website|web site|site|app|store|online store))?$/u.exec(
        query,
      );
    if (trail) {
      const name = cleanSiteName(trail[1] ?? '');
      const suffixed = Boolean(trail[2]);
      if (name && (suffixed || isCapitalisedIn(original, name))) {
        return { name, query: trimEdges(query.slice(0, trail.index)) };
      }
    }
  }
  if (command?.postfix) {
    // "Acme pe blue mugs dhoondo" / "Acme website alli blue mugs search maadu"
    const lead =
      /^([\p{L}\p{N}][\p{L}\p{N}&'.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}&'.-]*)?)(?:\s+(?:website|site|app))?\s+(?:pe|par|mein|alli|nalli|dalli)\s+(.+)$/u.exec(
        query,
      );
    if (lead) {
      const name = cleanSiteName(lead[1] ?? '');
      if (name) return { name, query: trimEdges(lead[2] ?? '') };
    }
  }
  return null;
}

// ── resolver ───────────────────────────────────────────────────────────────────────────────────

export interface ResolvedIntent {
  profile: IntentProfile;
  /** Known-site id when the target is a registered site. */
  siteId: string | null;
}

/** Entity marking an explicit "in this tab" request that also names a destination. */
export const CURRENT_TAB_ENTITY = { type: 'context', value: 'current-tab' } as const;
/** Entity type naming a browser command the agent cannot perform yet ("scroll", "go back"). */
export const UNSUPPORTED_ENTITY = 'unsupported';

/** Conversational openers of a follow-up: "now …", "ok then …", "next, …". */
const LEAD_FILLER_RE =
  /^(?:(?:ok(?:ay)?|now|then|next|also|so|and|alright|right|fine)(?:\s*,\s*|\s+))+/u;

/**
 * Page and browser commands that are not open/search/play/click. Until a later phase performs them,
 * they are refused with a clear message — never typed into a search engine.
 */
const UNSUPPORTED_RE =
  /^(scroll(?:\s+to\s+\S+)?|go\s+to\s+(?:the\s+)?next\s+page|next\s+page|refresh|reload|add\b.*\b(?:wishlist)|remove\b.*\b(?:cart|basket|bag|wishlist)|sort(?:\s+by)?|filter|show\s+(?:cheaper|costlier|more\s+expensive|less\s+expensive|more|fewer|less)|close(?:\s+(?:this|the))?|zoom(?:\s+(?:in|out))?|log\s?in|sign\s?in|log\s?out|sign\s?out|bookmark|download|print|pause|mute|unmute)(?![\p{L}\p{N}])/u;

function unsupportedIntent(original: string, command: string): ResolvedIntent {
  const profile = IntentProfile.parse({
    intent: 'unknown',
    targetDomain: null,
    directNavigation: false,
    action: null,
    query: null,
    constraints: [],
    entities: [{ type: UNSUPPORTED_ENTITY, value: squash(command).slice(0, 64) }],
    language: detectLanguage(original),
    riskLevel: 'LOW',
    requiresConfirmation: false,
    confidence: 0.9,
    resolvedBy: 'deterministic',
    targetSource: 'CURRENT_PAGE',
    navigationPolicy: 'REUSE_CURRENT_CONTEXT',
    siteName: null,
    ordinal: null,
  });
  return { profile, siteId: null };
}

/** Entity carrying a page command's parameter (scroll direction, which item to pick). */
export const COMMAND_ENTITY = 'command';

/**
 * Page commands the agent performs on the open page (Phase 5). Matched on the whole request after
 * conversational openers are removed; each maps to one generic goal — never to a site script.
 */
const PAGE_COMMANDS: Array<{ re: RegExp; action: string; param: (m: RegExpExecArray) => string }> =
  [
    {
      re: /^scroll(?:\s+(?:the\s+page\s+)?(up|down))?(?:\s+(?:a\s+(?:bit|little)|more|further|again|please))*$/u,
      action: 'scroll',
      param: (m) => m[1] ?? 'down',
    },
    {
      re: /^(?:go\s+)?back(?:\s+(?:to\s+(?:the\s+)?(?:previous|last)\s+page|please))?$|^(?:go\s+to\s+)?(?:the\s+)?previous\s+page$/u,
      action: 'go_back',
      param: () => 'back',
    },
    { re: /^go\s+forward$/u, action: 'go_forward', param: () => 'forward' },
    {
      re: /^(?:add|put)\b(?:\s+(?:it|this|that|the\s+item|this\s+item|this\s+product|one))?\s+(?:to|in|into)\s+(?:the\s+|my\s+)?(?:cart|basket|bag)$/u,
      action: 'add_to_cart',
      param: () => 'cart',
    },
    {
      re: /^(?:(?:go|proceed|continue)\s+to\s+|open\s+)(?:the\s+|my\s+)?(?:check\s?out|cart|basket|bag)$|^check\s?out$/u,
      action: 'checkout',
      param: (m) => (/check\s?out/.test(m[0]) ? 'checkout' : 'cart'),
    },
    {
      re: /^(?:auto\s?fill|fill\s+(?:in|out|up)?)\b.*$|^(?:complete|fill)\s+(?:this|the)\s+form\b.*$/u,
      action: 'fill_form',
      param: () => 'profile',
    },
    {
      re: /^(?:upload|attach)\b(?!\s+(?:a\s+)?(?:video|photo|picture|image)s?\s+(?:on|to)\s+\S+\.\S+)(?:\s+(?:it|this|that|the\s+file|my\s+file|the\s+attachment|my\s+(?:resume|cv|document|photo)|this\s+file))?(?:\s+(?:here|to\s+(?:this|the)\s+(?:page|form|site)))?$/u,
      action: 'upload_file',
      param: () => 'file',
    },
    {
      re: /^(?:summari[sz]e|sum\s+up|give\s+(?:me\s+)?(?:a\s+)?(?:short\s+)?summary|tl;?\s?dr|what(?:\s+is|'s|’s|s)\s+(?:this|the)\s+(?:page|article)\s+about)\b.*$/u,
      action: 'summarize',
      param: () => 'page',
    },
  ];

/** "the cheapest one", "open the top rated phone", "show me the most expensive" → pick by value. */
const PICK_RE =
  /(?:^|\s)(?:the\s+)?(cheapest|lowest[- ]priced|least\s+expensive|costliest|most\s+expensive|highest[- ]priced|top[- ]rated|best[- ]rated|highest[- ]rated)(?![\p{L}\p{N}])/u;
const SEARCH_VERB_RE = /(?:^|\s)(?:search|find|look\s+(?:for|up)|lookup|browse)(?![\p{L}\p{N}])/u;

function pickOf(word: string): 'cheapest' | 'costliest' | 'top-rated' {
  if (/cheapest|lowest|least/.test(word)) return 'cheapest';
  if (/rated/.test(word)) return 'top-rated';
  return 'costliest';
}

function commandIntent(
  original: string,
  action: string,
  param: string,
  intent: IntentProfile['intent'] = 'navigate',
): ResolvedIntent {
  const profile = IntentProfile.parse({
    intent,
    targetDomain: null,
    directNavigation: false,
    action,
    query: null,
    constraints: [],
    entities: [{ type: COMMAND_ENTITY, value: param }],
    language: detectLanguage(original),
    riskLevel: action === 'add_to_cart' || action === 'checkout' ? 'MEDIUM' : 'LOW',
    requiresConfirmation: false,
    confidence: 0.9,
    resolvedBy: 'deterministic',
    targetSource: 'CURRENT_PAGE',
    navigationPolicy: 'REUSE_CURRENT_CONTEXT',
    siteName: null,
    ordinal: null,
  });
  return { profile, siteId: null };
}

const SKILL_INTENT: Record<SkillId, IntentProfile['intent']> = {
  'summarize-page': 'summarize',
  'deep-research': 'research',
  'extract-data': 'extract',
  'compare-prices': 'compare_prices',
  'fill-form': 'form_fill',
  'find-alternatives': 'find_alternatives',
  'manage-bookmarks': 'bookmarks',
  'monitor-page': 'monitor',
  'organize-tabs': 'tab_management',
  'read-later': 'read_later',
  'save-page': 'save_page',
  'screenshot-walkthrough': 'screenshot_walkthrough',
};

function skillIntent(original: string, id: SkillId, arg: string): ResolvedIntent {
  const { constraints } = extractConstraints(arg.toLowerCase());
  const profile = IntentProfile.parse({
    intent: SKILL_INTENT[id],
    targetDomain: null,
    directNavigation: false,
    action: 'skill',
    query: null,
    constraints,
    entities: [
      { type: SKILL_ENTITY, value: id },
      { type: SKILL_ARG_ENTITY, value: arg.slice(0, 256) },
    ],
    language: detectLanguage(original),
    riskLevel: 'LOW',
    requiresConfirmation: false,
    confidence: 0.9,
    resolvedBy: 'deterministic',
    targetSource: 'CURRENT_PAGE',
    navigationPolicy: 'REUSE_CURRENT_CONTEXT',
    siteName: null,
    ordinal: null,
  });
  return { profile, siteId: null };
}

/** Constraints and the text without them, e.g. "laptops under ₹50,000" (used by skills). */
export function constraintsOf(text: string): { constraints: Constraint[]; rest: string } {
  return extractConstraints(normalize(text));
}

/** Entity type marking a request that points at something on the page code cannot pick alone. */
/**
 * A bare search phrase with no sentence around it: at most five words, no pronoun, question word,
 * negation or conversational filler. Anything that reads like a sentence goes to the models.
 */
const NOT_PLAIN_RE =
  /(?<![\p{L}\p{N}])(?:i|i'm|im|me|my|we|us|our|you|your|it|this|that|these|those|one|ones|what|which|who|how|why|when|where|want|need|like|not|no|hmm|umm|uh|maybe|sure|something|anything|some|please|make|let|give|get|go|turn|take|put|set|change|increase|decrease|bigger|smaller|larger|show|tell|help|compare|can|could|would|should|will|is|are|was|do|does|did)(?![\p{L}\p{N}])/iu;
function isPlainQuery(query: string): boolean {
  const words = query.trim().split(/\s+/);
  return words.length > 0 && words.length <= 5 && !NOT_PLAIN_RE.test(query);
}

export const AMBIGUOUS_ENTITY = 'ambiguous';

/**
 * "the samsung one", "that one", "the one with 256 GB", "the cheapest one", "which of these":
 * the user points at an item on screen by description. Code cannot know which element that is, so
 * it must not guess (e.g. resolve a website called "samsung one") — this goes to the model tiers.
 */
const PAGE_REFERENCE_RE =
  /(?:^|\s)(?:the|that|this)\s+(?:[\p{L}\p{N}-]+\s+){0,3}ones?(?=\s*(?:$|[,.?!]|(?:please|with|that|which|in|on|for|from|and|under|below|above|here|there|now)(?![\p{L}\p{N}])))|(?:^|\s)the\s+one\s+(?:with|that|which|in|for|from|under|below|above)\s|(?:^|\s)(?:of|from)\s+(?:these|those|them)(?![\p{L}\p{N}])|(?:^|\s)(?:which|what)\s+(?:one|of)\s/u;

function ambiguousIntent(original: string, mention: SiteMention | null): ResolvedIntent {
  const profile = IntentProfile.parse({
    intent: 'unknown',
    targetDomain: mention?.domain ?? null,
    directNavigation: false,
    action: null,
    query: null,
    constraints: [],
    entities: [{ type: AMBIGUOUS_ENTITY, value: 'page-reference' }],
    language: detectLanguage(original),
    riskLevel: 'LOW',
    requiresConfirmation: false,
    confidence: 0.3,
    resolvedBy: 'deterministic',
    targetSource: mention ? 'EXPLICIT_USER_TARGET' : 'CURRENT_PAGE',
    navigationPolicy: mention ? 'DIRECT_NAVIGATE' : 'REUSE_CURRENT_CONTEXT',
    siteName: null,
    ordinal: null,
  });
  return { profile, siteId: mention?.site?.id ?? null };
}

/** Words left over after "open <site>" that only restate the destination. */
const NAV_LEFTOVER_NOISE = new Set([
  '',
  'the',
  'a',
  'home',
  'homepage',
  'home page',
  'page',
  'site',
]);

/**
 * Resolve a request in any supported language (spec §45): Indic-script and romanized commands are
 * first rewritten into canonical command words (`canonicalize`), so "<query> play maadi",
 * "<site>ನಲ್ಲಿ <query> ಪ್ಲೇ ಮಾಡಿ" and "play <query> on <site>" reach the same intent.
 * The reported language is always detected from what the user actually wrote.
 */
export function resolveIntent(request: string): ResolvedIntent {
  const canonical = canonicalize(request);
  if (canonical === request) return resolveCanonical(request);
  const resolved = resolveCanonical(canonical);
  return { ...resolved, profile: { ...resolved.profile, language: detectLanguage(request) } };
}

function resolveCanonical(request: string): ResolvedIntent {
  // A request pasted inside quotes ("“now open the samsung one”") means the same without them.
  const original = request.trim().replace(/^["'“”‘’«»]+\s*|\s*["'“”‘’«»]+$/gu, '');
  const language = detectLanguage(original);
  const context = stripContext(normalize(original).replace(POLITE_RE, ' '));
  const explicitContext = context.found;
  const opened = squash(context.text.replace(LEAD_FILLER_RE, ''));
  const bare = opened.replace(/[.!?]+$/u, '').trim();
  // Commands are also matched before "this page"/"here" is stripped ("what is this page about").
  const unstripped = squash(normalize(original).replace(POLITE_RE, ' '))
    .replace(LEAD_FILLER_RE, '')
    .replace(/[.!?]+$/u, '')
    .trim();
  const skill = detectSkill(unstripped) ?? detectSkill(bare);
  if (skill) return skillIntent(original, skill.id, skill.arg);
  for (const command of PAGE_COMMANDS) {
    const m = command.re.exec(bare) ?? command.re.exec(unstripped);
    if (m) {
      const kind =
        command.action === 'add_to_cart' || command.action === 'checkout'
          ? 'shopping'
          : command.action === 'fill_form' || command.action === 'upload_file'
            ? 'form_fill'
            : command.action === 'summarize'
              ? 'summarize'
              : 'navigate';
      return commandIntent(original, command.action, command.param(m), kind);
    }
  }
  const pick = PICK_RE.exec(bare);
  if (pick && !SEARCH_VERB_RE.test(` ${bare}`) && !findSiteMention(bare)) {
    return commandIntent(original, 'pick_item', pickOf(pick[1]!), 'shopping');
  }
  const unsupported = UNSUPPORTED_RE.exec(opened);
  if (unsupported) return unsupportedIntent(original, unsupported[1] ?? unsupported[0]);
  const { main: text, followUp } = splitFollowUp(opened);
  const mention = findSiteMention(text);
  const { constraints, rest: withoutConstraints } = extractConstraints(text);
  const mentionAfterConstraints = findSiteMention(withoutConstraints);
  const reference = clauseReference(removeSiteMention(withoutConstraints, mentionAfterConstraints));
  if (!reference && PAGE_REFERENCE_RE.test(` ${text} `)) return ambiguousIntent(original, mention);
  const command = reference ? null : findCommand(withoutConstraints);
  const navigates =
    firstMatch(NAV_RE, withoutConstraints) !== null ||
    firstMatch(NAV_POSTFIX_RE, withoutConstraints) !== null;

  let query = '';
  if (command) {
    const segment = command.postfix
      ? withoutConstraints.slice(0, command.start)
      : withoutConstraints.slice(command.end);
    // Only the part of the segment in the same site context: drop a leading "open <site> and".
    const beforeCommandSite =
      mentionAfterConstraints && mentionAfterConstraints.end <= command.start;
    let working = segment;
    if (command.postfix || !beforeCommandSite) {
      const inSegment = findSiteMention(working);
      working = removeSiteMention(working, inSegment);
    }
    if (command.postfix) {
      // Postfix: the query is the clause right before the verb; drop any leading "open … and".
      const parts = working.split(/(?:,|;|\band\b|\bthen\b)/u);
      working = parts[parts.length - 1] ?? working;
      working = working.replace(NAV_RE, ' ');
    }
    query = trimEdges(stripQuotes(segment) ?? working);
  }

  // A website named by the user that is neither a domain nor a known site → resolve it later.
  let siteName: string | null = null;
  if (!mention && !reference) {
    const named = findSiteName(withoutConstraints, original, command, query);
    if (named) {
      siteName = restoreCase(original, named.name);
      if (named.query !== undefined) query = named.query;
    }
  }

  let intent: IntentProfile['intent'];
  let action: string | null;
  const siteId: string | null = mention?.site?.id ?? null;
  const targetDomain: string | null = mention?.domain ?? null;
  const namesSite = targetDomain !== null || siteName !== null;
  let confidence: number;
  let riskLevel: IntentProfile['riskLevel'] = 'LOW';
  let requiresConfirmation = false;
  let ordinal: number | null = null;

  if (reference) {
    // "play the first result" / "open the second one": act on results already on screen.
    intent = reference.media ? 'media_playback' : 'navigate';
    action = reference.media ? 'play_result' : 'open_result';
    ordinal = reference.ordinal;
    confidence = 0.9;
  } else if (command?.command === 'purchase') {
    intent = 'shopping';
    action = 'purchase';
    riskLevel = 'HIGH';
    requiresConfirmation = true;
    confidence = namesSite ? 0.9 : 0.8;
  } else if (command?.command === 'play' && query) {
    intent = 'media_playback';
    action = 'search_and_play';
    confidence = namesSite ? 0.95 : 0.85;
  } else if (command && query) {
    intent = mention?.site?.category === 'shopping' ? 'shopping' : 'search';
    action = 'search';
    confidence = namesSite ? 0.95 : 0.85;
  } else if (namesSite && (navigates || !command)) {
    // "Open Flipkart iPhone": whatever is left after the site and the verb is what to look for.
    const leftover = mentionAfterConstraints
      ? trimEdges(
          removeSiteMention(withoutConstraints, mentionAfterConstraints)
            .replace(NAV_RE, ' ')
            .replace(NAV_POSTFIX_RE, ' ')
            .replace(/^\s*the\s+/u, ' '),
        )
      : '';
    if (!NAV_LEFTOVER_NOISE.has(leftover)) {
      query = leftover;
      intent = mention?.site?.category === 'shopping' ? 'shopping' : 'search';
      action = 'search';
      confidence = 0.85;
    } else {
      intent = 'navigate';
      action = 'navigate';
      confidence = siteName ? 0.8 : navigates ? 0.97 : 0.8;
    }
  } else if (navigates && !command) {
    // "open a new tab", "open my cart": an open-request whose object is not a website. Browser and
    // in-page management are later capabilities — say so instead of searching the web for it.
    intent = 'unknown';
    action = null;
    confidence = 0.2;
  } else {
    // No site and no recognisable command: treat the whole request as a generic web search.
    query = trimEdges(withoutConstraints.replace(NAV_RE, ' '));
    intent = query ? 'search' : 'unknown';
    action = query ? 'search' : null;
    // A short name-like query ("iphone 15", "samsung phones") is a plain search: code is sure, so no
    // model is asked (on the Mac that saved 4–6 s per follow-up). Sentences stay unsure.
    confidence = !query ? 0.1 : isPlainQuery(query) ? 0.85 : 0.5;
  }

  if (followUp && query && (action === 'search' || action === 'search_and_play')) {
    // "search X and play/open the first one".
    action = followUp.media ? 'search_and_play' : 'search_and_open';
    if (followUp.media) intent = 'media_playback';
    ordinal = followUp.ordinal;
  }

  // Proposed navigation policy from the wording alone; the planner finalises it with the tab context.
  let targetSource: IntentProfile['targetSource'];
  let navigationPolicy: IntentProfile['navigationPolicy'];
  if (targetDomain) {
    targetSource = 'EXPLICIT_USER_TARGET';
    navigationPolicy = 'DIRECT_NAVIGATE';
  } else if (siteName) {
    targetSource = 'RESOLVED_WEBSITE';
    navigationPolicy = 'RESOLVE_WEBSITE';
  } else if (explicitContext || command || reference) {
    targetSource = explicitContext ? 'CURRENT_TAB' : 'CURRENT_PAGE';
    navigationPolicy = 'REUSE_CURRENT_CONTEXT';
  } else {
    // No verb at all ("laptops with 16GB RAM"): a web search is the honest reading.
    targetSource = 'SEARCH_DISCOVERY';
    navigationPolicy = 'SEARCH_AS_LAST_RESORT';
  }

  const entities = [
    ...(targetDomain ? [{ type: 'site', value: targetDomain }] : []),
    ...(siteName ? [{ type: 'site_name', value: siteName.slice(0, 80) }] : []),
    ...(query ? [{ type: 'query', value: query.slice(0, 256) }] : []),
    ...(explicitContext ? [CURRENT_TAB_ENTITY] : []),
  ];

  query = restoreCase(original, query);
  const profile = IntentProfile.parse({
    intent,
    targetDomain,
    directNavigation: targetDomain !== null,
    action,
    query: query ? query.slice(0, 512) : null,
    constraints,
    entities,
    language,
    riskLevel,
    requiresConfirmation,
    confidence,
    resolvedBy: 'deterministic',
    targetSource,
    navigationPolicy,
    siteName: siteName ? siteName.slice(0, 80) : null,
    ordinal,
  });
  return { profile, siteId };
}

/** True when the request explicitly asked to work in the current tab. */
export function wantsCurrentTab(profile: IntentProfile): boolean {
  return profile.entities.some(
    (e) => e.type === CURRENT_TAB_ENTITY.type && e.value === CURRENT_TAB_ENTITY.value,
  );
}
