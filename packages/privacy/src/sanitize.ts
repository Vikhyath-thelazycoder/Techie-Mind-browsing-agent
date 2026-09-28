import {
  PrivacyFinding,
  SanitizedObservation,
  type DOMNode,
  type Observation,
  type PrivacyCategory,
  type PrivacyKind,
} from '@techie-mind/contracts';
import { detectField, detectText, type Detection } from './detect.js';
import type { TokenVault } from './vault.js';

/**
 * Local redaction (spec §15, plan §18). Sensitive spans become semantic placeholders:
 *   - identity / contact / financial values → vault tokens ("PHONE_001"), resolvable locally
 *   - passwords, OTPs, CVVs, secrets → "[REDACTED_PASSWORD]" — never tokenized, never resolvable
 * A model (Phase 3) reasons over "PERSON_001 lives at ADDRESS_001" — never the real values.
 */

/** Kinds that are never stored even in the vault: nothing may ever re-type them for the user. */
export const NEVER_TOKENIZE: ReadonlySet<PrivacyKind> = new Set<PrivacyKind>([
  'password',
  'otp',
  'cvv',
  'api_key',
  'jwt',
  'auth_token',
  'secret',
]);

export interface RedactionStats {
  total: number;
  byKind: Partial<Record<PrivacyKind, number>>;
  byCategory: Partial<Record<PrivacyCategory, number>>;
}

export function emptyStats(): RedactionStats {
  return { total: 0, byKind: {}, byCategory: {} };
}

function count(stats: RedactionStats, kind: PrivacyKind, category: PrivacyCategory) {
  stats.total += 1;
  stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;
}

export function placeholder(kind: PrivacyKind): string {
  return `[REDACTED_${kind.toUpperCase()}]`;
}

export interface RedactResult {
  text: string;
  detections: Detection[];
  tokens: Array<{ kind: PrivacyKind; token: string | null }>;
}

/** Redact free text. With a vault, tokenizable values become tokens; otherwise placeholders. */
export function redactText(text: string, vault: TokenVault | null = null): RedactResult {
  const detections = detectText(text);
  if (detections.length === 0) return { text, detections, tokens: [] };
  let out = '';
  let cursor = 0;
  const tokens: RedactResult['tokens'] = [];
  for (const d of detections) {
    const value = text.slice(d.start, d.end);
    const token = vault && !NEVER_TOKENIZE.has(d.kind) ? vault.tokenize(d.kind, value) : null;
    out += text.slice(cursor, d.start) + (token ?? placeholder(d.kind));
    cursor = d.end;
    tokens.push({ kind: d.kind, token });
  }
  out += text.slice(cursor);
  return { text: out, detections, tokens };
}

/** Redact for logs/history: placeholders only, nothing stored. */
export function redactForLog(text: string): string {
  return redactText(text, null).text;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** URL safe to record: origin + path (sensitive segments redacted); no query string or fragment. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${redactForLog(decodeSafe(u.pathname))}`;
  } catch {
    return '';
  }
}

export interface SanitizeResult {
  observation: SanitizedObservation;
  findings: PrivacyFinding[];
  stats: RedactionStats;
  ms: number;
}

/**
 * Turn a raw local observation into the only representation allowed to leave the browser:
 * no field values at all, redacted names/text, no query string, a finding per sensitive item.
 */
export function sanitizeObservation(
  obs: Observation,
  vault: TokenVault,
  clock: () => number = () => performance.now(),
): SanitizeResult {
  const started = clock();
  const findings: PrivacyFinding[] = [];
  const stats = emptyStats();
  let seq = 0;
  const finding = (
    node: DOMNode,
    kind: PrivacyKind,
    category: PrivacyCategory,
    layer: PrivacyFinding['layer'],
    confidence: number,
    token: string | null,
  ) => {
    count(stats, kind, category);
    if (findings.length >= 2000) return;
    findings.push(
      PrivacyFinding.parse({
        findingId: `pf-${obs.observationId}-${++seq}`,
        category,
        kind,
        layer,
        location: { kind: 'dom', nodeId: node.nodeId },
        confidence,
        treatment: token ? 'tokenize' : 'redact',
        token,
      }),
    );
  };

  const nodes = obs.domNodes.slice(0, 2000).map((node) => {
    // Layer 1: a sensitive field is sensitive whatever it currently holds.
    const field = detectField(node);
    if (field && node.value) {
      const token = NEVER_TOKENIZE.has(field.kind) ? null : vault.tokenize(field.kind, node.value);
      finding(node, field.kind, field.category, field.layer, field.confidence, token);
    }
    const clean = (value: string | null, max: number) => {
      if (!value) return null;
      const r = redactText(value, vault);
      r.detections.forEach((d, i) =>
        finding(node, d.kind, d.category, d.layer, d.confidence, r.tokens[i]?.token ?? null),
      );
      return r.text.slice(0, max);
    };
    return {
      nodeId: node.nodeId,
      role: node.role,
      name: clean(node.name, 512),
      text: clean(node.text, 2000),
      interactive: node.interactive,
      editable: node.editable,
      bbox: node.bbox,
    };
  });

  const title = redactText(obs.title, vault).text.slice(0, 512);
  let path = '/';
  try {
    path = redactForLog(decodeSafe(new URL(obs.url).pathname)).slice(0, 2048);
  } catch {
    path = '/';
  }
  const observation = SanitizedObservation.parse({
    observationId: obs.observationId,
    version: obs.version,
    origin: obs.origin,
    path,
    title,
    createdAt: obs.createdAt,
    nodes,
    findings,
    redactionCount: stats.total,
    sanitized: true,
  });
  return { observation, findings, stats, ms: clock() - started };
}
