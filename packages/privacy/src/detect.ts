import type { DOMNode, PrivacyCategory, PrivacyKind } from '@techie-mind/contracts';
import { aadhaarValid, cardValid, entropy, gstinValid } from './checksums.js';

/**
 * Local sensitive-data detection (spec §14, plan §17). Layered:
 *   1. DOM semantics  — what a field IS (type=password, autocomplete=cc-number, label "Aadhaar")
 *   2. patterns       — what a string LOOKS like (e-mail, Indian mobile, PAN, IFSC, JWT, API keys)
 *   3. checksums/context — what a number provably IS (Verhoeff Aadhaar, Luhn card, GSTIN check char)
 *                          or what the words around it say ("OTP is 482913", "A/c no 00123…")
 *   + entropy          — random-looking secrets no pattern knows
 * Regex alone is never the only evidence for number-shaped identifiers: a 12-digit number without a
 * valid Verhoeff digit is not an Aadhaar number unless the text says so.
 * Visual layers (OCR, faces) are Phase 4.
 */

export type Layer = 'dom-semantics' | 'pattern' | 'checksum';

export interface Detection {
  start: number;
  end: number;
  kind: PrivacyKind;
  category: PrivacyCategory;
  layer: Layer;
  confidence: number;
}

export const CATEGORY_OF: Record<PrivacyKind, PrivacyCategory> = {
  password: 'PASSWORD',
  email: 'PII',
  phone: 'PII',
  name: 'PII',
  address: 'PII',
  pin_code: 'PII',
  aadhaar: 'IDENTITY',
  pan: 'IDENTITY',
  voter_id: 'IDENTITY',
  passport: 'IDENTITY',
  driving_licence: 'IDENTITY',
  gstin: 'FINANCIAL',
  ifsc: 'FINANCIAL',
  upi_id: 'FINANCIAL',
  bank_account: 'FINANCIAL',
  card_number: 'FINANCIAL',
  cvv: 'FINANCIAL',
  otp: 'AUTHENTICATION',
  api_key: 'SECRET',
  jwt: 'SECRET',
  auth_token: 'SECRET',
  secret: 'SECRET',
  face: 'PII',
  other: 'PII',
};

interface Rule {
  kind: PrivacyKind;
  re: RegExp;
  confidence: number;
  layer?: Layer;
  /** Value group (default: whole match). */
  group?: number;
  /** Extra acceptance test on the value. */
  valid?: (value: string, text: string, index: number) => boolean;
  /** Context words that must appear shortly before the value. */
  context?: RegExp;
}

const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
const re = (body: string, flags = 'gu') => new RegExp(`${B}${body}${E}`, flags);

/** Case-insensitive alternation of cue words (the name after them stays case-sensitive). */
function ci(words: readonly string[]): string {
  const alt = [...words]
    .sort((a, b) => b.length - a.length)
    .map((w) =>
      w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).replace(/\./g, '\\.'),
    )
    .join('|');
  return `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}])`;
}

/** Words shortly before a value that give it meaning ("OTP is", "A/c no"). */
function hasContext(text: string, index: number, context: RegExp): boolean {
  const window = text.slice(Math.max(0, index - 48), index).toLowerCase();
  return context.test(window);
}

const RULES: Rule[] = [
  // ── secrets (highest priority: a token may contain digits that look like phones) ─────────────
  {
    kind: 'jwt',
    re: re('eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
    confidence: 0.99,
  },
  {
    kind: 'api_key',
    re: re(
      '(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}|SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,})',
    ),
    confidence: 0.98,
  },
  {
    kind: 'auth_token',
    re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gu,
    group: 1,
    confidence: 0.97,
  },
  {
    kind: 'password',
    re: /\b(?:pass(?:word|wd|code)?|pwd)\s*(?:is|[:=])\s*["']?([^\s"',;]{4,64})/giu,
    group: 1,
    confidence: 0.9,
  },
  {
    kind: 'auth_token',
    re: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?key)?|client[_-]?secret|session[_-]?id)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/giu,
    group: 1,
    confidence: 0.93,
  },
  // Sensitive values inside URLs: ?token=…&key=…&sig=…&otp=…
  {
    kind: 'auth_token',
    re: /[?&#](?:access_token|id_token|refresh_token|token|key|api_key|apikey|secret|password|pwd|sig|signature|session|sessionid|sid|auth|code|otp)=([^&#\s"'<>]{6,})/giu,
    group: 1,
    confidence: 0.92,
  },
  // ── contact ──────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'email',
    re: re('[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,24}'),
    confidence: 0.99,
  },
  {
    // UPI VPA: name@handle — no dot after @ (that would be an e-mail).
    kind: 'upi_id',
    re: re('[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,24}(?![.@])'),
    confidence: 0.85,
  },
  // ── financial (checksum-validated) ───────────────────────────────────────────────────────────
  {
    kind: 'card_number',
    re: re('(?:\\d[ -]?){12,18}\\d'),
    layer: 'checksum',
    confidence: 0.97,
    valid: (v) => cardValid(v),
  },
  {
    kind: 'gstin',
    re: re('\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]'),
    layer: 'checksum',
    confidence: 0.97,
    valid: (v) => gstinValid(v),
  },
  { kind: 'ifsc', re: re('[A-Z]{4}0[A-Z0-9]{6}'), confidence: 0.9 },
  {
    kind: 'cvv',
    re: re('\\d{3,4}'),
    confidence: 0.9,
    context: /(?:cvv|cvc|cvv2|card verification|security code)\W{0,12}$/,
  },
  {
    kind: 'bank_account',
    re: re('\\d{9,18}'),
    confidence: 0.9,
    context: /(?:a\/c|acct|account)\s*(?:no|number|#)?\.?\s*[:-]?\s*$/,
  },
  // ── identity ─────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'aadhaar',
    re: re('[2-9]\\d{3}[ -]?\\d{4}[ -]?\\d{4}'),
    layer: 'checksum',
    confidence: 0.98,
    valid: (v, text, i) => aadhaarValid(v) || hasContext(text, i, /(?:aadhaa?r|आधार|uid|uidai)/),
  },
  { kind: 'pan', re: re('[A-Z]{3}[PCHABGJLFT][A-Z]\\d{4}[A-Z]'), confidence: 0.95 },
  {
    kind: 'voter_id',
    re: re('[A-Z]{3}\\d{7}'),
    confidence: 0.85,
    context: /(?:voter|epic|election)\b[^\n]{0,30}$/,
  },
  {
    kind: 'passport',
    re: re('[A-PR-WY][1-9]\\d\\s?\\d{4}[1-9]'),
    confidence: 0.9,
    context: /passport\b[^\n]{0,30}$/,
  },
  {
    kind: 'driving_licence',
    re: re('[A-Z]{2}[ -]?\\d{2}[ -]?(?:19|20)\\d{2}[ -]?\\d{7}'),
    confidence: 0.9,
  },
  // ── one-time codes ───────────────────────────────────────────────────────────────────────────
  {
    kind: 'otp',
    re: re('\\d{4,8}'),
    confidence: 0.92,
    context:
      /(?:otp|one[- ]time (?:password|code)|verification code|security code|login code|code is|passcode)\W{0,16}(?:is\W{0,4})?$/,
  },
  // ── phone ────────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'phone',
    re: /(?<![\p{L}\p{N}+])(?:(?:\+|00)91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\p{N})/gu,
    confidence: 0.93,
  },
  {
    kind: 'phone',
    re: /(?<![\p{L}\p{N}])\+[1-9]\d{0,2}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\p{N})/gu,
    confidence: 0.85,
  },
  // ── location ─────────────────────────────────────────────────────────────────────────────────
  {
    kind: 'pin_code',
    re: re('[1-9]\\d{2}\\s?\\d{3}'),
    confidence: 0.85,
    context: /(?:pin\s?code|pincode|postal code|zip(?: code)?|pin)\W{0,6}$/,
  },
  // ── people ───────────────────────────────────────────────────────────────────────────────────
  {
    // Personal names need a cue: a label ("Name:"), an honorific, a greeting or a profile header.
    // Keywords are matched case-insensitively; the name itself must be Capitalised Words.
    kind: 'name',
    re: new RegExp(
      `(?:${ci([
        'full name',
        'name',
        'customer',
        'account holder',
        'holder name',
        'profile of',
        'signed in as',
        'logged in as',
        'welcome back',
        'welcome',
        'hello',
        'dear',
        'mr.',
        'mrs.',
        'ms.',
        'dr.',
        'mr',
        'mrs',
        'ms',
        'dr',
        'shri',
        'smt.',
        'smt',
      ])})\\s*[:,-]?\\s*((?:\\p{Lu}[\\p{Ll}'’-]+)(?:\\s+\\p{Lu}[\\p{Ll}'’-]+){1,3})`,
      'gu',
    ),
    group: 1,
    confidence: 0.8,
  },
  {
    kind: 'address',
    re: /\b(?:address|addr\.?|residing at|lives at)\s*[:-]\s*([^\n]{12,160}?)(?=\s*(?:\n|$|\||;|(?:phone|mobile|email|pin)\b))/giu,
    group: 1,
    confidence: 0.8,
  },
];

const PRIORITY: PrivacyKind[] = [
  'jwt',
  'api_key',
  'auth_token',
  'password',
  'email',
  'card_number',
  'gstin',
  'aadhaar',
  'upi_id',
  'ifsc',
  'pan',
  'voter_id',
  'passport',
  'driving_licence',
  'otp',
  'cvv',
  'bank_account',
  'phone',
  'pin_code',
  'address',
  'name',
  'secret',
];

/** Random-looking tokens (≥24 chars, ≥3 character classes, ≥3.6 bits/char) that no pattern knows. */
function entropySecrets(text: string): Detection[] {
  const out: Detection[] = [];
  const TOKEN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,256}(?![A-Za-z0-9+/_=-])/g;
  for (const m of text.matchAll(TOKEN)) {
    const v = m[0];
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_=-]/].filter((r) => r.test(v)).length;
    if (classes < 3 || entropy(v) < 3.6) continue;
    if (/^[a-z]+(?:[-_][a-z]+)+$/i.test(v)) continue; // slugs
    // Identifiers that are random by design but not secrets: UUIDs, hex digests.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) continue;
    if (/^[0-9a-f]+$/i.test(v)) continue;
    out.push({
      start: m.index,
      end: m.index + v.length,
      kind: 'secret',
      category: 'SECRET',
      layer: 'pattern',
      confidence: 0.75,
    });
  }
  return out;
}

/** Detect sensitive spans in free text. Overlaps are resolved by kind priority, then length. */
export function detectText(text: string): Detection[] {
  if (!text) return [];
  const found: Detection[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value) continue;
      const start = (m.index ?? 0) + (rule.group ? m[0].indexOf(value) : 0);
      if (rule.context && !hasContext(text, start, rule.context)) continue;
      if (rule.valid && !rule.valid(value, text, start)) continue;
      found.push({
        start,
        end: start + value.length,
        kind: rule.kind,
        category: CATEGORY_OF[rule.kind],
        layer: rule.layer ?? 'pattern',
        confidence: rule.confidence,
      });
    }
  }
  found.push(...entropySecrets(text));
  return resolveOverlaps(found);
}

function resolveOverlaps(found: Detection[]): Detection[] {
  const rank = (d: Detection) => PRIORITY.indexOf(d.kind);
  const sorted = [...found].sort(
    (a, b) => rank(a) - rank(b) || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: Detection[] = [];
  for (const d of sorted) {
    if (kept.some((k) => d.start < k.end && k.start < d.end)) continue;
    kept.push(d);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ── layer 1: DOM semantics ──────────────────────────────────────────────────────────────────

const AUTOCOMPLETE_KIND: Array<[RegExp, PrivacyKind]> = [
  [/\b(?:current-password|new-password)\b/, 'password'],
  [/\bone-time-code\b/, 'otp'],
  [/\bcc-number\b/, 'card_number'],
  [/\bcc-csc\b/, 'cvv'],
  [/\bemail\b/, 'email'],
  [/\btel(?:-national|-local)?\b/, 'phone'],
  [/\b(?:street-address|address-line[123]|address-level[1-4])\b/, 'address'],
  [/\bpostal-code\b/, 'pin_code'],
  [/\b(?:name|given-name|family-name|additional-name|cc-name)\b/, 'name'],
];

const LABEL_KIND: Array<[RegExp, PrivacyKind]> = [
  [/pass(?:word|wd|code)|\bpwd\b|\bmpin\b|\bupi pin\b|\batm pin\b/i, 'password'],
  [/\botp\b|one[- ]time|verification code/i, 'otp'],
  [/\bcvv\b|\bcvc\b|security code/i, 'cvv'],
  [/card\s*(?:no|number)|debit card|credit card/i, 'card_number'],
  [/aadhaa?r|\buid\b|आधार/i, 'aadhaar'],
  [/\bpan\b(?:\s*(?:card|no|number))?|permanent account/i, 'pan'],
  [/\bupi\b|\bvpa\b/i, 'upi_id'],
  [/\bifsc\b/i, 'ifsc'],
  [/account\s*(?:no|number)|\ba\/c\b/i, 'bank_account'],
  [/\bgstin?\b/i, 'gstin'],
  [/passport/i, 'passport'],
  [/voter|\bepic\b/i, 'voter_id'],
  [/driving\s*licen[cs]e|\bdl\s*(?:no|number)\b/i, 'driving_licence'],
  [/e-?mail/i, 'email'],
  [/phone|mobile|\bcontact number\b|whatsapp/i, 'phone'],
  [/pin\s?code|postal|\bzip\b/i, 'pin_code'],
  [/address|street|landmark/i, 'address'],
  [/(?:full|first|last|your)\s*name|^name$/i, 'name'],
  [/api[_\s-]?key|secret|token/i, 'secret'],
];

export interface FieldDetection {
  kind: PrivacyKind;
  category: PrivacyCategory;
  layer: 'dom-semantics';
  confidence: number;
}

/** What an editable field holds, from its semantics alone (its value is not needed). */
export function detectField(node: DOMNode): FieldDetection | null {
  if (!node.editable && node.tag !== 'input' && node.tag !== 'textarea') return null;
  const hit = (kind: PrivacyKind, confidence: number): FieldDetection => ({
    kind,
    category: CATEGORY_OF[kind],
    layer: 'dom-semantics',
    confidence,
  });
  if (node.inputType === 'password') return hit('password', 0.99);
  const autocomplete = (node.attributes['autocomplete'] ?? '').toLowerCase();
  for (const [pattern, kind] of AUTOCOMPLETE_KIND) {
    if (pattern.test(autocomplete)) return hit(kind, 0.95);
  }
  if (node.inputType === 'email') return hit('email', 0.95);
  if (node.inputType === 'tel') return hit('phone', 0.9);
  const label = [
    node.name,
    node.attributes['aria-label'],
    node.attributes['placeholder'],
    node.attributes['name'],
    node.attributes['id'],
    node.attributes['title'],
  ]
    .filter(Boolean)
    .join(' ');
  // Search boxes hold the user's own query, not a stored identity.
  if (node.role === 'searchbox' || node.inputType === 'search' || /search|query/i.test(label)) {
    return null;
  }
  for (const [pattern, kind] of LABEL_KIND) if (pattern.test(label)) return hit(kind, 0.85);
  return null;
}

// ── whole-page scan (runs in the page; returns counts only) ─────────────────────────────────

export interface PageScan {
  total: number;
  byKind: Partial<Record<PrivacyKind, number>>;
  /** Filled form fields that hold sensitive data. */
  fields: number;
  /** The rendered text that was scanned — stays in the page; callers must never send it. */
  text: string;
  textChars: number;
  truncated: boolean;
  ms: number;
}

const MAX_SCAN_CHARS = 400_000;

/**
 * Scan a document's rendered text and filled fields. Runs inside the page (content script) so the
 * raw text never leaves it: only counts per kind are returned. Text hidden from the user is not
 * rendered and therefore not scanned (it is never observed by the agent either).
 */
export function scanDocument(
  doc: Document,
  clock: () => number = () => performance.now(),
): PageScan {
  const started = clock();
  const byKind: Partial<Record<PrivacyKind, number>> = {};
  const add = (kind: PrivacyKind) => (byKind[kind] = (byKind[kind] ?? 0) + 1);
  const body = doc.body as (HTMLElement & { innerText?: string }) | null;
  const full = (typeof body?.innerText === 'string' ? body.innerText : body?.textContent) ?? '';
  const text = full.slice(0, MAX_SCAN_CHARS);
  for (const d of detectText(text)) add(d.kind);
  let fields = 0;
  for (const el of Array.from(doc.querySelectorAll('input, textarea'))) {
    const input = el as HTMLInputElement;
    if (!input.value || ['hidden', 'submit', 'button', 'checkbox', 'radio'].includes(input.type)) {
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const name of ['autocomplete', 'name', 'id', 'placeholder', 'aria-label', 'title']) {
      const v = input.getAttribute(name);
      if (v) attrs[name] = v;
    }
    const label = input.labels?.[0]?.textContent?.trim() ?? null;
    const semantic = detectField({
      nodeId: 'scan',
      parentId: null,
      tag: input.tagName.toLowerCase(),
      role: input.type === 'search' ? 'searchbox' : 'textbox',
      name: attrs['aria-label'] ?? label,
      text: null,
      attributes: attrs,
      inputType: input.tagName === 'TEXTAREA' ? null : input.type,
      formId: null,
      value: null,
      visible: true,
      interactive: true,
      editable: true,
      bbox: null,
    });
    const kinds = semantic ? [semantic.kind] : detectText(input.value).map((d) => d.kind);
    if (kinds.length > 0) fields += 1;
    kinds.forEach(add);
  }
  const total = Object.values(byKind).reduce((n, v) => n + (v ?? 0), 0);
  return {
    total,
    byKind,
    fields,
    text,
    textChars: text.length,
    truncated: full.length > MAX_SCAN_CHARS,
    ms: clock() - started,
  };
}
