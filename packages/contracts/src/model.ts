import { z } from 'zod';
import { ActionProposal } from './action.js';
import { IntentProfile } from './intent.js';
import { Confidence, Id, ShortText, Timestamp } from './primitives.js';
import { SanitizedObservation } from './privacy.js';

/** Model tiers of spec §18. Tier 0 (code) never produces a ModelRequest. */
export const ModelTier = z.enum(['laya', 'qwen', 'vision', 'api']);
export type ModelTier = z.infer<typeof ModelTier>;

export const ModelPurpose = z.enum([
  'classify-intent',
  'plan-action',
  'extract',
  'summarize',
  'research',
  'recovery-classification',
  'visual-grounding',
]);

/**
 * A request to any model. It can only carry a SanitizedObservation (never a raw Observation), and
 * the `sanitized: true` literal forces the privacy gate to have run before construction.
 */
export const ModelRequest = z.strictObject({
  requestId: Id,
  taskId: Id,
  tier: ModelTier,
  modelId: z.string().min(1).max(128),
  purpose: ModelPurpose,
  userGoal: z.string().max(4000),
  intent: IntentProfile.nullable(),
  observation: SanitizedObservation.nullable(),
  createdAt: Timestamp,
  sanitized: z.literal(true),
});
export type ModelRequest = z.infer<typeof ModelRequest>;

const decisionBase = {
  requestId: Id,
  modelId: z.string().min(1).max(128),
  tier: ModelTier,
  latencyMs: z.number().nonnegative(),
};

export const ModelDecision = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('action'), ...decisionBase, proposal: ActionProposal }),
  z.strictObject({
    kind: z.literal('classification'),
    ...decisionBase,
    label: z.string().min(1).max(64),
    confidence: Confidence,
  }),
  z.strictObject({ kind: z.literal('answer'), ...decisionBase, text: z.string().max(20_000) }),
  z.strictObject({ kind: z.literal('abstain'), ...decisionBase, reason: ShortText }),
]);
export type ModelDecision = z.infer<typeof ModelDecision>;
