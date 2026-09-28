/**
 * Log-safety masking. This is a defence-in-depth backstop so obviously sensitive values never reach
 * a log sink; it is NOT the privacy engine (Phase 2), which does real PII detection before anything
 * leaves the browser.
 */

export const MASK = '[MASKED]';

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|session|otp|cvv|card|aadhaar|pan(number)?$|phone|mobile|e-?mail|address|pin(code)?$|upi|ifsc|account/i;

const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // API-key style secrets
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // bearer tokens
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // e-mail addresses
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7}\b/g, // card / Aadhaar-like digit groups
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /(?<!\d)(?:\+91[ -]?)?[6-9]\d{9}(?!\d)/g, // Indian mobile numbers
];

export const MAX_LOG_STRING = 1000;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function maskString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) out = out.replace(pattern, MASK);
  return out.length > MAX_LOG_STRING ? `${out.slice(0, MAX_LOG_STRING - 1)}…` : out;
}

export type LogValue = string | number | boolean | null;

/** Flatten arbitrary data into masked, primitive-only log fields. Nested objects are not logged. */
export function maskData(data: Record<string, unknown>): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(data).slice(0, 64)) {
    const safeKey = key.slice(0, 64);
    if (isSensitiveKey(key)) {
      out[safeKey] = value === null || value === undefined ? null : MASK;
    } else if (typeof value === 'string') {
      out[safeKey] = maskString(value);
    } else if (typeof value === 'number') {
      out[safeKey] = Number.isFinite(value) ? value : null;
    } else if (typeof value === 'boolean' || value === null) {
      out[safeKey] = value;
    } else if (value === undefined) {
      continue;
    } else {
      out[safeKey] = '[OMITTED]';
    }
  }
  return out;
}
