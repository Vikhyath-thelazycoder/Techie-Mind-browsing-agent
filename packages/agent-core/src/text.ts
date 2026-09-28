/** Text utilities shared by intent resolution, grounding and verification. */

/** Lowercase, NFKC, ASCII quotes, collapsed whitespace, no trailing sentence punctuation. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim();
}

/** Unicode-aware word tokens (letters/digits), lowercased, diacritics removed. */
export function tokenize(text: string): string[] {
  const folded = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Light plural folding for term matching: "songs"↔"song", "shoes"↔"shoe" (not "glass"). */
export function foldTerm(term: string): string {
  return term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term;
}

/** How many distinct query terms appear in `haystack` (token-level match, plural-folded). */
export function countTerms(haystack: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const tokens = new Set(tokenize(haystack).map(foldTerm));
  return new Set(terms.map(foldTerm).filter((t) => tokens.has(t))).size;
}

export function allTermsIn(haystack: string, terms: readonly string[]): boolean {
  const unique = new Set(terms);
  return unique.size > 0 && countTerms(haystack, [...unique]) === unique.size;
}

/** Decode a URL for term matching: percent-decoding, '+' as space. Never throws. */
export function decodeUrlForMatching(url: string): string {
  const plus = url.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
