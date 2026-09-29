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

// ── Phase 3: tiered intelligence ────────────────────────────────────────────────────────────────

/**
 * What kind of request an uncertain command is (Laya, tier 1). Laya only answers typed choices;
 * it never produces free text, queries or actions.
 */
export const RequestCategory = z.enum([
  'search',
  'open_website',
  'play_media',
  'pick_result',
  'page_command',
  'unclear',
]);
export type RequestCategory = z.infer<typeof RequestCategory>;

export const LayaClassification = z.strictObject({
  category: RequestCategory,
  confidence: Confidence,
  /** Laya's own "not sure — pass it up" decision. */
  escalate: z.boolean(),
});
export type LayaClassification = z.infer<typeof LayaClassification>;

/** Actions a model may choose between. The runtime maps them onto its own goals. */
export const ModelIntentAction = z.enum([
  'navigate',
  'search',
  'search_and_play',
  'open_result',
  'play_result',
]);
export type ModelIntentAction = z.infer<typeof ModelIntentAction>;

/**
 * How the reasoning model (tier 2/4) reads an uncertain command. Every field is re-checked by code:
 * a query must come from the user's words, a site is resolved by the deterministic router, and an
 * element must exist in the observation the model was shown.
 */
export const ModelInterpretation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('intent'),
    action: ModelIntentAction,
    site: z.string().trim().min(1).max(80).nullable(),
    query: z.string().trim().min(1).max(256).nullable(),
    ordinal: z.number().int().min(1).max(50).nullable(),
    confidence: Confidence,
    reason: ShortText,
  }),
  z.strictObject({
    kind: z.literal('element'),
    elementId: Id,
    media: z.boolean(),
    confidence: Confidence,
    reason: ShortText,
  }),
  z.strictObject({
    kind: z.literal('abstain'),
    question: ShortText,
    reason: ShortText,
  }),
  /** Small talk or a general question that needs no website: a short reply, shown as text only. */
  z.strictObject({
    kind: z.literal('chat'),
    reply: z.string().trim().min(1).max(600),
    confidence: Confidence,
    reason: ShortText,
  }),
]);
export type ModelInterpretation = z.infer<typeof ModelInterpretation>;

/** How one model call ended. Only `answered` is ever acted on. */
export const ModelOutcome = z.enum([
  'answered',
  'escalated',
  'abstained',
  'unavailable',
  'invalid',
  'timeout',
  'blocked',
  'rejected',
]);
export type ModelOutcome = z.infer<typeof ModelOutcome>;

/** One model call made during a task — metadata only, never prompts or page content. */
export const ModelUsage = z.strictObject({
  tier: ModelTier,
  modelId: z.string().min(1).max(128),
  purpose: z.enum(['classify-intent', 'plan-action', 'visual-grounding']),
  outcome: ModelOutcome,
  latencyMs: z.number().nonnegative(),
  reason: ShortText.nullable(),
});
export type ModelUsage = z.infer<typeof ModelUsage>;

// ── Phase 4: visual grounding ───────────────────────────────────────────────────────────────────

/**
 * What the local vision model may answer: where the described target is in the (redacted) image,
 * as a box in image pixels — or that it is not there. Never an action, never page coordinates:
 * code maps the box to the page and to a DOM element.
 */
export const VisualLocation = z.discriminatedUnion('found', [
  z.strictObject({
    found: z.literal(true),
    box: z.tuple([
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
    ]),
    label: z.string().max(200),
    confidence: Confidence,
  }),
  z.strictObject({ found: z.literal(false), reason: ShortText }),
]);
export type VisualLocation = z.infer<typeof VisualLocation>;
