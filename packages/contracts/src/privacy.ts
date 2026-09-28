import { z } from 'zod';
import { BoundingBox, Confidence, Id, Origin, Timestamp, VaultToken } from './primitives.js';

/** Redaction categories (spec §15). */
export const PrivacyCategory = z.enum([
  'PASSWORD',
  'PII',
  'FACE',
  'SECRET',
  'FINANCIAL',
  'AUTHENTICATION',
  'IDENTITY',
]);
export type PrivacyCategory = z.infer<typeof PrivacyCategory>;

/** Concrete kinds of sensitive data the detectors recognise (spec §14). */
export const PrivacyKind = z.enum([
  'password',
  'email',
  'phone',
  'name',
  'address',
  'pin_code',
  'aadhaar',
  'pan',
  'voter_id',
  'passport',
  'driving_licence',
  'gstin',
  'ifsc',
  'upi_id',
  'bank_account',
  'card_number',
  'cvv',
  'otp',
  'api_key',
  'jwt',
  'auth_token',
  'secret',
  'face',
  'other',
]);
export type PrivacyKind = z.infer<typeof PrivacyKind>;

/** Detection layer that produced a finding (spec §14, layers 1–5). */
export const DetectionLayer = z.enum([
  'dom-semantics',
  'pattern',
  'checksum',
  'visual-ocr',
  'face-detection',
]);

export const FindingLocation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dom'), nodeId: Id }),
  z.strictObject({ kind: z.literal('region'), regionId: Id, bbox: BoundingBox }),
  z.strictObject({ kind: z.literal('field'), path: z.string().max(256) }),
]);

/**
 * A sensitive-data finding. Deliberately has NO field that can carry the raw value:
 * strict parsing rejects any extra key, so a detector cannot leak the secret through this type.
 */
export const PrivacyFinding = z.strictObject({
  findingId: Id,
  category: PrivacyCategory,
  kind: PrivacyKind,
  layer: DetectionLayer,
  location: FindingLocation,
  confidence: Confidence,
  treatment: z.enum(['redact', 'tokenize', 'block']),
  token: VaultToken.nullable(),
});
export type PrivacyFinding = z.infer<typeof PrivacyFinding>;

/** A node after local sanitization — the only page representation allowed to leave the browser. */
export const SanitizedNode = z.strictObject({
  nodeId: Id,
  role: z.string().max(64).nullable(),
  name: z.string().max(512).nullable(),
  text: z.string().max(2000).nullable(),
  interactive: z.boolean(),
  editable: z.boolean(),
  bbox: BoundingBox.nullable(),
});
export type SanitizedNode = z.infer<typeof SanitizedNode>;

export const SanitizedObservation = z.strictObject({
  observationId: Id,
  version: z.number().int().nonnegative(),
  origin: Origin,
  /** URL with query string and fragment removed locally. */
  path: z.string().max(2048),
  title: z.string().max(512),
  createdAt: Timestamp,
  nodes: z.array(SanitizedNode).max(2000),
  findings: z.array(PrivacyFinding).max(2000),
  redactionCount: z.number().int().nonnegative(),
  sanitized: z.literal(true),
});
export type SanitizedObservation = z.infer<typeof SanitizedObservation>;
