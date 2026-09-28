import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ModelRequest,
  type DOMNode,
  type Observation,
  type PrivacyKind,
} from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { aadhaarValid, cardValid, gstinValid, luhnValid, verhoeffValid } from '../src/checksums.js';
import { detectField, detectText } from '../src/detect.js';
import { isPublicHostname, OutboundPrivacyGate } from '../src/gate.js';
import { redactForLog, safeUrl, sanitizeObservation } from '../src/sanitize.js';
import { TokenVault } from '../src/vault.js';
import { aadhaar, aadhaarInvalid, buildCorpus, card, cardInvalid, gstin, pan } from './corpus.js';

const kinds = (text: string) => detectText(text).map((d) => d.kind);

describe('checksums (detection layer 3)', () => {
  it('validates Verhoeff/Aadhaar, Luhn/card and GSTIN and rejects corrupted values', () => {
    for (let i = 0; i < 20; i++) {
      expect(aadhaarValid(aadhaar())).toBe(true);
      expect(aadhaarValid(aadhaarInvalid())).toBe(false);
      expect(cardValid(card())).toBe(true);
      expect(cardValid(cardInvalid())).toBe(false);
      expect(gstinValid(gstin())).toBe(true);
    }
    expect(verhoeffValid('2363')).toBe(true); // textbook example: 236 + check digit 3
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(aadhaarValid('123456789012')).toBe(false); // Aadhaar never starts with 0/1
  });
});

describe('detection — the spec §80 privacy test page', () => {
  it('finds name, e-mail, phone, Aadhaar, PAN, password and card number', () => {
    const a = aadhaar();
    const c = card();
    const p = pan();
    const text = `Name: Asha Verma\nEmail: asha.verma@example.com\nPhone: +91 98765 43210\nAadhaar: ${a.slice(0, 4)} ${a.slice(4, 8)} ${a.slice(8)}\nPAN: ${p}\npassword: Tr0ub4dor&3\nCard: ${c}`;
    expect(new Set(kinds(text))).toEqual(
      new Set(['name', 'email', 'phone', 'aadhaar', 'pan', 'password', 'card_number']),
    );
  });
});

describe('detection — Indian identity, financial and secret kinds', () => {
  it.each<[string, PrivacyKind]>([
    ['IFSC HDFC0001234 for the branch', 'ifsc'],
    ['pay to rahul99@okaxis now', 'upi_id'],
    [`GSTIN ${gstin()}`, 'gstin'],
    ['Your OTP is 482913. Do not share it.', 'otp'],
    ['A/c no 004301523311 credited', 'bank_account'],
    ['Pincode 560038', 'pin_code'],
    ['CVV: 123', 'cvv'],
    ['voter id ABC1234567', 'voter_id'],
    ['passport no J8369854', 'passport'],
    ['DL KA01 20190012345', 'driving_licence'],
    [
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt',
    ],
    ['key sk-proj-abcdefghijklmnopqrstuvwx1234', 'api_key'],
    // Key-shaped fixtures are assembled at runtime so the repository secret scan stays strict.
    [['AKIA', 'IOSFODNN7EXAMPLE'].join(''), 'api_key'],
    ['Authorization: Bearer abcdef1234567890ghijkl', 'auth_token'],
    ['https://x.example.com/cb?code=Zx81kQpL0aa&state=1', 'auth_token'],
    ['secret: 9f8e7d6c5b4a', 'auth_token'],
    ['blob Qm9X/a8+Zk2L7pT4wR1vN6yH3eJ0cB5s', 'secret'],
  ])('%s', (text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it('does not flag look-alikes (prices, dates, order ids, ISBNs, UUIDs, bad checksums)', () => {
    for (const text of [
      'Price ₹1,299 only',
      'Delivered on 2024-05-12',
      'Order OD432156789012345 shipped',
      'ISBN 978-3-16-148410-0',
      `Request id ${crypto.randomUUID()}`,
      `Task task-${crypto.randomUUID()} started`,
      `Observation obs-task-${crypto.randomUUID()}-12`,
      // Digit runs inside UUIDs/digests look like phone/Aadhaar numbers (this one did, as a phone).
      'Request id 0da0f277-1d9a-4afd-b158-7287271663da',
      'Request id 97023411-6895-40a6-8fd2-93a4176f8dba',
      'Commit 8059041973ea747888b90d9dfebad58c14706056',
      `Reference ${aadhaarInvalid()}`,
      `Item code ${cardInvalid()}`,
      'Version v2.10.3',
      'Commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'Rated 4.5 out of 5 by 2310 buyers',
      'Kannada songs 2024 hits',
    ]) {
      expect(kinds(text), text).toEqual([]);
    }
  });
});

function field(extra: Partial<DOMNode>): DOMNode {
  return {
    nodeId: 'f',
    parentId: null,
    tag: 'input',
    role: 'textbox',
    name: null,
    text: null,
    attributes: {},
    inputType: 'text',
    formId: null,
    value: null,
    visible: true,
    interactive: true,
    editable: true,
    bbox: null,
    ...extra,
  };
}

describe('detection — layer 1 DOM semantics', () => {
  it('knows what a field holds from its type, autocomplete and label', () => {
    expect(detectField(field({ inputType: 'password' }))?.kind).toBe('password');
    expect(detectField(field({ attributes: { autocomplete: 'cc-number' } }))?.kind).toBe(
      'card_number',
    );
    expect(detectField(field({ attributes: { autocomplete: 'one-time-code' } }))?.kind).toBe('otp');
    expect(detectField(field({ name: 'Aadhaar number' }))?.kind).toBe('aadhaar');
    expect(detectField(field({ attributes: { placeholder: 'Enter PAN' } }))?.kind).toBe('pan');
    expect(detectField(field({ inputType: 'tel' }))?.kind).toBe('phone');
    // Search boxes hold the user's own query.
    expect(
      detectField(field({ role: 'searchbox', inputType: 'search', name: 'Search' })),
    ).toBeNull();
  });
});

describe('detection — labelled synthetic corpus (plan §52 metrics)', () => {
  it('reaches precision ≥ 0.95 and recall ≥ 0.95, and writes evidence', () => {
    const corpus = buildCorpus();
    const perKind: Record<string, { tp: number; fp: number; fn: number }> = {};
    const bump = (k: string, f: 'tp' | 'fp' | 'fn') => {
      perKind[k] ??= { tp: 0, fp: 0, fn: 0 };
      perKind[k][f] += 1;
    };
    let negatives = 0;
    let falseRedactions = 0;
    for (const sample of corpus) {
      const found = detectText(sample.text);
      const matched = new Set<number>();
      for (const span of sample.spans) {
        const start = sample.text.indexOf(span.value);
        const end = start + span.value.length;
        const hit = found.findIndex(
          (d, i) => !matched.has(i) && d.kind === span.kind && d.start < end && start < d.end,
        );
        if (hit >= 0) {
          matched.add(hit);
          bump(span.kind, 'tp');
        } else bump(span.kind, 'fn');
      }
      found.forEach((d, i) => {
        if (!matched.has(i)) bump(d.kind, 'fp');
      });
      if (sample.spans.length === 0) {
        negatives += 1;
        if (found.length > 0) falseRedactions += 1;
      }
    }
    const sum = (f: 'tp' | 'fp' | 'fn') => Object.values(perKind).reduce((n, k) => n + k[f], 0);
    const tp = sum('tp');
    const precision = tp / (tp + sum('fp'));
    const recall = tp / (tp + sum('fn'));
    const f1 = (2 * precision * recall) / (precision + recall);
    const evidence = {
      generatedAt: new Date().toISOString(),
      samples: corpus.length,
      negatives,
      overall: { precision, recall, f1 },
      falseRedactionRate: falseRedactions / negatives,
      perKind: Object.fromEntries(
        Object.entries(perKind).map(([k, v]) => [
          k,
          { ...v, precision: v.tp / (v.tp + v.fp || 1), recall: v.tp / (v.tp + v.fn || 1) },
        ]),
      ),
    };
    const dir = resolve(import.meta.dirname, '../../../evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'privacy-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    expect(corpus.length).toBeGreaterThanOrEqual(300);
    expect(precision, JSON.stringify(evidence.perKind)).toBeGreaterThanOrEqual(0.95);
    expect(recall, JSON.stringify(evidence.perKind)).toBeGreaterThanOrEqual(0.95);
    expect(evidence.falseRedactionRate).toBeLessThanOrEqual(0.05);
  });
});

describe('token vault', () => {
  it('tokenizes consistently and resolves locally, single use', () => {
    const vault = new TokenVault();
    const t = vault.tokenize('phone', '9876543210');
    expect(t).toBe('PHONE_001');
    expect(vault.tokenize('phone', '9876543210')).toBe('PHONE_001');
    expect(vault.tokenize('phone', '9123456780')).toBe('PHONE_002');
    expect(vault.resolve(t)).toBe('9876543210');
    expect(vault.resolve(t)).toBeNull(); // consumed
    expect(vault.resolve('PHONE_002', { consume: false })).toBe('9123456780');
    expect(vault.has('PHONE_002')).toBe(true);
  });

  it('expires entries after the TTL and bounds its size', () => {
    let now = 0;
    const vault = new TokenVault({ ttlMs: 1_000, maxEntries: 2, now: () => now });
    const t = vault.tokenize('email', 'a@example.com');
    vault.tokenize('email', 'b@example.com');
    expect(() => vault.tokenize('email', 'c@example.com')).toThrow(/full/);
    now = 1_001;
    expect(vault.resolve(t)).toBeNull();
    expect(vault.size).toBe(0);
  });

  it('is scoped to its task, purgeable, and never serializes or prints a value', () => {
    const a = new TokenVault();
    const b = new TokenVault();
    const t = a.tokenize('aadhaar', '234123412346');
    expect(b.resolve(t)).toBeNull();
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify({ a })).not.toContain('234123412346');
    expect(String(a)).not.toContain('234123412346');
    a.purge();
    expect(a.resolve(t)).toBeNull();
    expect(() => a.tokenize('email', 'x@example.com')).toThrow(/purged/);
  });

  it('never touches persistent storage (memory only)', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/vault.ts'), 'utf8');
    expect(source).not.toMatch(/localStorage|indexedDB|chrome\.storage|storageSet|sessionStorage/);
  });
});

function observation(nodes: DOMNode[]): Observation {
  return {
    observationId: 'obs-1',
    taskId: 'task-1',
    tabId: 1,
    documentId: 'doc-1',
    origin: 'https://profile.example.com',
    url: 'https://profile.example.com/u/asha.verma@example.com?token=abcdef123456&x=1',
    title: 'Profile of Asha Verma',
    version: 0,
    createdAt: 0,
    viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
    domNodes: nodes,
    a11yNodes: [],
    visualRegions: [],
  };
}

describe('sanitizeObservation — the only page form that may leave the browser', () => {
  const a = aadhaar();
  const c = card();
  const raw = [
    'Asha Verma',
    'asha.verma@example.com',
    '9876543210',
    a,
    'ABCPV1234K',
    'hunter2secret',
    c,
    'abcdef123456',
  ];
  const obs = observation([
    field({
      nodeId: 'n1',
      tag: 'p',
      role: null,
      editable: false,
      interactive: false,
      text: 'Name: Asha Verma',
    }),
    field({
      nodeId: 'n2',
      tag: 'p',
      role: null,
      editable: false,
      text: 'Mail asha.verma@example.com or call 9876543210',
    }),
    field({ nodeId: 'n3', name: 'Aadhaar number', value: a }),
    field({ nodeId: 'n4', name: 'PAN', value: 'ABCPV1234K' }),
    field({ nodeId: 'n5', inputType: 'password', name: 'Password', value: 'hunter2secret' }),
    field({
      nodeId: 'n6',
      attributes: { autocomplete: 'cc-number' },
      name: 'Card number',
      value: c,
    }),
    field({
      nodeId: 'n7',
      role: 'searchbox',
      inputType: 'search',
      name: 'Search',
      value: 'garden hose',
    }),
  ]);

  it('contains no raw value, keeps tokens, drops the query string and counts findings', () => {
    const vault = new TokenVault();
    const { observation: clean, stats } = sanitizeObservation(obs, vault);
    const json = JSON.stringify(clean);
    for (const value of raw) expect(json, value).not.toContain(value);
    expect(clean.path).not.toContain('?');
    expect(clean.path).not.toContain('asha.verma');
    expect(clean.nodes.find((n) => n.nodeId === 'n1')?.text).toBe('Name: PERSON_001');
    // Page-content findings (the URL copy is redacted as part of the path, not counted).
    expect(stats.byKind).toMatchObject({
      email: 1,
      phone: 1,
      aadhaar: 1,
      pan: 1,
      password: 1,
      card_number: 1,
    });
    expect(stats.byKind.name).toBeGreaterThanOrEqual(1);
    // Tokenized values resolve locally; passwords are never stored at all.
    expect(vault.resolve('EMAIL_001', { consume: false })).toBe('asha.verma@example.com');
    expect(clean.findings.find((f) => f.kind === 'password')).toMatchObject({
      treatment: 'redact',
      token: null,
    });
    // The sanitized form can travel in a ModelRequest; the gate accepts it.
    const request = ModelRequest.parse({
      requestId: 'r1',
      taskId: 'task-1',
      tier: 'qwen',
      modelId: 'qwen2.5:7b',
      purpose: 'plan-action',
      userGoal: 'search for garden hose',
      intent: null,
      observation: clean,
      createdAt: 0,
      sanitized: true,
    });
    const gate = new OutboundPrivacyGate();
    expect(
      gate.inspect({
        purpose: 'model',
        url: 'http://127.0.0.1:11434/api/chat',
        method: 'POST',
        payload: request,
      }),
    ).toMatchObject({ allowed: true });
  });

  it('redacts logs and URLs without storing anything', () => {
    expect(redactForLog('mail me at asha.verma@example.com')).toBe('mail me at [REDACTED_EMAIL]');
    expect(safeUrl('https://x.example.com/users/9876543210/orders?token=abc123456')).toBe(
      'https://x.example.com/users/[REDACTED_PHONE]/orders',
    );
  });
});

describe('outbound privacy gate', () => {
  const gate = new OutboundPrivacyGate();
  const model = (payload: unknown) =>
    gate.inspect({
      purpose: 'model',
      url: 'http://127.0.0.1:11434/api/chat',
      method: 'POST',
      payload,
    });

  it('blocks raw PII and secrets anywhere in the payload — never auto-fixes', () => {
    expect(model({ userGoal: 'my phone is 9876543210' })).toMatchObject({
      allowed: false,
      check: 'pii',
    });
    expect(model({ note: `aadhaar ${aadhaar()}` })).toMatchObject({ allowed: false, check: 'pii' });
    expect(model({ key: 'sk-proj-abcdefghijklmnopqrstuvwx1234' })).toMatchObject({
      allowed: false,
      check: 'secret',
    });
    const decision = model({ userGoal: 'mail asha.verma@example.com' });
    expect(JSON.stringify(decision)).not.toContain('asha.verma');
    expect(decision.findings).toEqual({ email: 1 });
  });

  it('blocks raw page structures and schema-invalid model payloads', () => {
    expect(model({ observation: { domNodes: [] } })).toMatchObject({ check: 'sanitization' });
    expect(model({ userGoal: 'search for garden hose' })).toMatchObject({ check: 'schema' });
  });

  it('refuses private, loopback, IP-literal and non-https internet destinations (SSRF)', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://192.168.1.1/',
      'https://localhost/',
      'https://printer.local/',
      'http://kestrelmart.com/',
      'https://[::1]/',
    ]) {
      expect(gate.inspect({ purpose: 'website-probe', url }), url).toMatchObject({
        allowed: false,
        check: 'allowlist',
      });
    }
    expect(
      gate.inspect({ purpose: 'website-probe', url: 'https://kestrelmart.com/' }).allowed,
    ).toBe(true);
    expect(
      gate.inspect({ purpose: 'website-probe', url: 'https://kestrelmart.com/?u=a%40b.com' }),
    ).toMatchObject({ allowed: false });
    expect(gate.inspect({ purpose: 'model', url: 'https://api.example.com/v1' })).toMatchObject({
      allowed: false,
    });
    expect(isPublicHostname('shop.example.co.in')).toBe(true);
  });

  it('reports every decision as metadata only', () => {
    const seen: unknown[] = [];
    const g = new OutboundPrivacyGate({ onDecision: (d) => seen.push(d) });
    g.inspect({ purpose: 'website-probe', url: 'https://kestrelmart.com/?phone=9876543210' });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('9876543210');
  });
});
