import { z } from 'zod';

/** Opaque identifier: bounded, printable, no whitespace. */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, 'identifier may only contain A-Z a-z 0-9 _ - : .');
export type Id = z.infer<typeof Id>;

/** Epoch milliseconds. */
export const Timestamp = z.number().int().nonnegative();

/** Probability / confidence in [0, 1]. */
export const Confidence = z.number().min(0).max(1);

/** Bounded human-readable text (reasons, descriptions). Never used for raw page content. */
export const ShortText = z.string().max(500);

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Absolute http(s) URL. Rejects javascript:, data:, file:, chrome:, etc. */
export const WebUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    const url = parseUrl(v);
    return url !== null && WEB_PROTOCOLS.has(url.protocol);
  }, 'must be an absolute http(s) URL');

/**
 * A page URL that fits the 2048-character contract limit. Sign-in pages (Amazon, Google) carry
 * return-to queries far longer than that; the query and fragment are dropped, origin + path kept.
 */
export function boundedWebUrl(href: string): string {
  if (href.length <= 2048) return href;
  const url = parseUrl(href);
  if (!url) return href.slice(0, 2048);
  return `${url.origin}${url.pathname}`.slice(0, 2048);
}

/** Serialized origin such as "https://www.youtube.com" (no path, no trailing slash). */
export const Origin = z
  .string()
  .max(512)
  .refine((v) => {
    const url = parseUrl(v);
    return url !== null && WEB_PROTOCOLS.has(url.protocol) && url.origin === v;
  }, 'must be a serialized http(s) origin');

/** Registrable-style hostname such as "youtube.com". */
export const Domain = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'must be a lowercase hostname',
  );

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** Languages the agent accepts input in (spec §44–45). Language never changes security policy. */
export const Language = z.enum(['en', 'hi', 'kn', 'ta', 'te', 'hinglish', 'mixed', 'unknown']);
export type Language = z.infer<typeof Language>;

export const BoundingBox = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

/** Which layer produced a decision. Used for routing telemetry and "no silent model substitution". */
export const DecisionSource = z.enum(['deterministic', 'laya', 'qwen', 'vision', 'api', 'human']);
export type DecisionSource = z.infer<typeof DecisionSource>;

/** A local token-vault reference, e.g. PHONE_001. The raw value never leaves the vault. */
export const VaultToken = z.string().regex(/^[A-Z]{2,24}_\d{3}$/, 'must look like PHONE_001');
export type VaultToken = z.infer<typeof VaultToken>;
