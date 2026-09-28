import { ModelRequest, type PrivacyKind } from '@techie-mind/contracts';
import { detectText } from './detect.js';

/**
 * Outbound privacy gate (spec §17, plan §20). EVERY request that leaves the extension goes through
 * `gatedFetch` — model calls (Phase 3), website-resolution probes, monitoring (Phase 8). In order:
 *
 *   1. serialize      the payload must be plain JSON, bounded in size
 *   2. PII scan       e-mail, phone, Aadhaar, PAN, card, bank, UPI, OTP, names … in body AND URL
 *   3. secret scan    keys, tokens, JWTs, high-entropy strings
 *   4. sanitization   page content only as a SanitizedObservation; no raw DOM, no field values
 *   5. schema         model payloads must parse as ModelRequest
 *   6. allowlist      destination host allowed for the purpose; no private/loopback targets for
 *                     internet purposes (SSRF), no internet targets for local model purposes
 *   → SEND, or BLOCK.
 *
 * It never "fixes" a payload and continues: an unsafe payload is refused, and the refusal (with
 * counts and kinds — never values) is reported.
 */

export type OutboundPurpose = 'website-probe' | 'model' | 'monitor';

export interface OutboundRequest {
  purpose: OutboundPurpose;
  url: string;
  method?: 'GET' | 'POST';
  /** JSON body (POST) — null/undefined for GET. */
  payload?: unknown;
}

export interface GateDecision {
  allowed: boolean;
  purpose: OutboundPurpose;
  host: string;
  bytes: number;
  /** First failed check, or "passed". */
  check: 'serialize' | 'pii' | 'secret' | 'sanitization' | 'schema' | 'allowlist' | 'passed';
  reasons: string[];
  /** Kinds found (counts only; never values). */
  findings: Partial<Record<PrivacyKind, number>>;
}

export class PrivacyGateError extends Error {
  constructor(readonly decision: GateDecision) {
    super(
      `outbound request blocked by the privacy gate (${decision.check}): ${decision.reasons.join('; ')}`,
    );
  }
}

const MAX_PAYLOAD_BYTES = 512 * 1024;
const SECRET_KINDS = new Set<PrivacyKind>(['api_key', 'jwt', 'auth_token', 'secret', 'password']);
/** Keys only a raw (unsanitized) page representation has. */
const RAW_KEYS = new Set([
  'domNodes',
  'a11yNodes',
  'value',
  'outerHTML',
  'innerHTML',
  'html',
  'cookies',
  'cookie',
]);

/** A hostname that is safe to fetch from the open internet (not an IP literal, not private). */
export function isPublicHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return false;
  if (/^\d+(\.\d+){3}$/.test(h)) return false; // IPv4 literal
  if (
    /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(
      h,
    )
  ) {
    return false;
  }
  return /\.[a-z]{2,24}$/.test(h);
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

export interface GateOptions {
  /** Extra per-purpose host rules (e.g. a configured remote model endpoint, test fixtures). */
  allow?: Partial<Record<OutboundPurpose, (host: string) => boolean>>;
  /** Called with every decision (metadata only) — e.g. the audit log. */
  onDecision?: (decision: GateDecision) => void;
}

export class OutboundPrivacyGate {
  constructor(private readonly options: GateOptions = {}) {}

  inspect(request: OutboundRequest): GateDecision {
    const base = { purpose: request.purpose, bytes: 0, findings: {} as GateDecision['findings'] };
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return this.#decide({
        ...base,
        allowed: false,
        host: '',
        check: 'allowlist',
        reasons: ['invalid URL'],
      });
    }
    const host = url.hostname;
    const block = (
      check: GateDecision['check'],
      reasons: string[],
      extra: Partial<GateDecision> = {},
    ) => this.#decide({ ...base, ...extra, allowed: false, host, check, reasons });

    // 1. serialize
    let body = '';
    if (request.payload !== undefined && request.payload !== null) {
      try {
        body = JSON.stringify(request.payload);
      } catch {
        return block('serialize', ['payload is not plain JSON']);
      }
    }
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > MAX_PAYLOAD_BYTES) {
      return block('serialize', [`payload too large (${bytes} bytes)`], { bytes });
    }

    // 2 + 3. PII and secrets — in the URL (path, query, fragment) and in the body.
    const scanned = `${decodeSafe(url.pathname)} ${decodeSafe(url.search)} ${decodeSafe(url.hash)}\n${body}`;
    const findings: GateDecision['findings'] = {};
    for (const d of detectText(scanned)) findings[d.kind] = (findings[d.kind] ?? 0) + 1;
    const kinds = Object.keys(findings) as PrivacyKind[];
    const secrets = kinds.filter((k) => SECRET_KINDS.has(k));
    const pii = kinds.filter((k) => !SECRET_KINDS.has(k));
    if (pii.length > 0) {
      return block('pii', [`raw sensitive data: ${pii.join(', ')}`], { bytes, findings });
    }
    if (secrets.length > 0) {
      return block('secret', [`credentials or secrets: ${secrets.join(', ')}`], {
        bytes,
        findings,
      });
    }

    // 4. sanitization — no raw page structures anywhere in the payload.
    const raw = findRawKey(request.payload);
    if (raw) return block('sanitization', [`raw page data field "${raw}" in payload`], { bytes });

    // 5. schema
    if (request.purpose === 'model' && !ModelRequest.safeParse(request.payload).success) {
      return block('schema', ['payload is not a ModelRequest'], { bytes });
    }
    if (
      request.purpose === 'website-probe' &&
      (body !== '' || url.search !== '' || url.pathname !== '/' || request.method === 'POST')
    ) {
      return block('schema', ['website probes are bodiless GETs of a site root'], { bytes });
    }

    // 6. allowlist / SSRF
    const allow = this.options.allow?.[request.purpose];
    if (request.purpose === 'model') {
      if (!(isLoopbackHost(host) || allow?.(host))) {
        return block('allowlist', [`${host} is not a configured model endpoint`], { bytes });
      }
    } else {
      if (url.protocol !== 'https:')
        return block('allowlist', ['only https is allowed'], { bytes });
      if (!isPublicHostname(host) && !allow?.(host)) {
        return block('allowlist', [`${host} is not a public internet host`], { bytes });
      }
    }
    return this.#decide({ ...base, bytes, allowed: true, host, check: 'passed', reasons: [] });
  }

  #decide(decision: GateDecision): GateDecision {
    this.options.onDecision?.(decision);
    return decision;
  }
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function findRawKey(value: unknown, depth = 0): string | null {
  if (depth > 12 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findRawKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RAW_KEYS.has(key)) return key;
    const hit = findRawKey(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * The only way runtime code may reach the network. Blocks unsafe requests before any byte leaves;
 * never sends cookies or referrers.
 */
export async function gatedFetch(
  gate: OutboundPrivacyGate,
  request: OutboundRequest,
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  const decision = gate.inspect(request);
  if (!decision.allowed) throw new PrivacyGateError(decision);
  const post = request.method === 'POST';
  return fetch(request.url, {
    method: post ? 'POST' : 'GET',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    ...(post
      ? { body: JSON.stringify(request.payload), headers: { 'content-type': 'application/json' } }
      : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}
