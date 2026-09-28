import { z } from 'zod';
import {
  BoundingBox,
  Confidence,
  DecisionSource,
  Id,
  Origin,
  ShortText,
  Timestamp,
  VaultToken,
  WebUrl,
} from './primitives.js';

/** Identity of the element or visual region an action targets. */
export const TargetRef = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('element'),
    elementId: Id,
    /** Stable fingerprint (tag/role/name hash) used to detect that a different node now holds the id. */
    fingerprint: z.string().max(128).nullable(),
  }),
  z.strictObject({
    kind: z.literal('region'),
    regionId: Id,
    /** Coordinates are only legal when produced by visual grounding (spec §22). */
    bbox: BoundingBox,
  }),
]);
export type TargetRef = z.infer<typeof TargetRef>;

/**
 * Seven-field binding (spec §6, §11): every executable action is tied to the exact task, observation,
 * document, tab, origin, target and observation version it was planned against. The firewall rejects
 * the action if any of these no longer match the live page.
 */
export const ActionBinding = z.strictObject({
  taskId: Id,
  observationId: Id,
  documentId: Id,
  tabId: z.number().int().nonnegative(),
  /**
   * Origin of the page the action was planned against. Null only when the tab shows no web document
   * (new tab, about:blank) — and then only NAVIGATE is permitted (enforced by `Action`).
   */
  origin: Origin.nullable(),
  target: TargetRef.nullable(),
  observationVersion: z.number().int().nonnegative(),
});
export type ActionBinding = z.infer<typeof ActionBinding>;

/** How the runtime will verify the action actually worked (spec §28). */
export const ExpectedOutcome = z.strictObject({
  kind: z.enum([
    'dom-mutation',
    'url-changed',
    'field-value',
    'result-set-changed',
    'media-playing',
    'cart-changed',
    'element-visible',
    'data-extracted',
    'none',
  ]),
  description: ShortText,
});
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;

/** Keys the agent may press. Anything else is rejected. */
export const AllowedKey = z.enum([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/** Text to type: either plain non-sensitive text or a local vault token (spec §16). Never both. */
export const TypeInput = z.union([
  z.strictObject({ text: z.string().max(2000) }),
  z.strictObject({ vaultToken: VaultToken }),
]);

/** Action-specific arguments, discriminated by `type`. There is intentionally no "script" action. */
export const ActionArgs = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('NAVIGATE'), url: WebUrl }),
  z.strictObject({ type: z.literal('CLICK') }),
  z.strictObject({ type: z.literal('TYPE'), input: TypeInput, submit: z.boolean() }),
  z.strictObject({ type: z.literal('CLEAR') }),
  z.strictObject({ type: z.literal('SELECT'), value: z.string().max(512) }),
  z.strictObject({
    type: z.literal('SCROLL'),
    direction: z.enum(['up', 'down', 'into-view']),
    amount: z.number().int().min(1).max(10_000).nullable(),
  }),
  z.strictObject({ type: z.literal('PRESS_KEY'), key: AllowedKey }),
  z.strictObject({
    type: z.literal('WAIT'),
    until: z.enum(['load', 'network-idle', 'dom-stable', 'element-visible']),
    timeoutMs: z.number().int().min(50).max(30_000),
  }),
  z.strictObject({
    type: z.literal('EXTRACT'),
    fields: z.array(z.string().min(1).max(64)).min(1).max(64),
  }),
  z.strictObject({ type: z.literal('HIGHLIGHT') }),
  z.strictObject({ type: z.literal('FOCUS') }),
  z.strictObject({ type: z.literal('HOVER') }),
  z.strictObject({ type: z.literal('UPLOAD'), fileRef: Id }),
  z.strictObject({ type: z.literal('DONE'), summary: ShortText }),
  z.strictObject({
    type: z.literal('HANDOVER'),
    reason: z.enum([
      'otp',
      'captcha',
      'payment',
      'login',
      'ambiguous',
      'verification-failed',
      'policy',
    ]),
    instruction: ShortText,
  }),
]);
export type ActionArgs = z.infer<typeof ActionArgs>;
export type ActionType = ActionArgs['type'];

export const ACTION_TYPES = [
  'NAVIGATE',
  'CLICK',
  'TYPE',
  'CLEAR',
  'SELECT',
  'SCROLL',
  'PRESS_KEY',
  'WAIT',
  'EXTRACT',
  'HIGHLIGHT',
  'FOCUS',
  'HOVER',
  'UPLOAD',
  'DONE',
  'HANDOVER',
] as const satisfies readonly ActionType[];

/** Action types that operate on a specific element/region and therefore require a bound target. */
export const TARGETED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'CLICK',
  'TYPE',
  'CLEAR',
  'SELECT',
  'HIGHLIGHT',
  'FOCUS',
  'HOVER',
  'UPLOAD',
]);

/** A fully bound, executable action — the only shape the browser executor accepts. */
export const Action = z
  .strictObject({
    actionId: Id,
    binding: ActionBinding,
    args: ActionArgs,
    reason: ShortText,
    confidence: Confidence,
    expectedOutcome: ExpectedOutcome,
    proposedBy: DecisionSource,
    createdAt: Timestamp,
  })
  .superRefine((action, ctx) => {
    if (TARGETED_ACTIONS.has(action.args.type) && action.binding.target === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'target'],
        message: `${action.args.type} requires a bound target`,
      });
    }
    if (action.binding.origin === null && action.args.type !== 'NAVIGATE') {
      ctx.addIssue({
        code: 'custom',
        path: ['binding', 'origin'],
        message: `${action.args.type} requires a page origin; only NAVIGATE may leave a non-web tab`,
      });
    }
  });
export type Action = z.infer<typeof Action>;

/**
 * What a model is allowed to emit. It names an element from the sanitized observation it was shown;
 * the local runtime — never the model — turns this into a bound Action (spec §2 "reasoning ≠ authority").
 */
export const ActionProposal = z.strictObject({
  observationId: Id,
  targetElementId: Id.nullable(),
  args: ActionArgs,
  reason: ShortText,
  confidence: Confidence,
  expectedOutcome: ExpectedOutcome,
});
export type ActionProposal = z.infer<typeof ActionProposal>;

export const ActionResult = z.strictObject({
  actionId: Id,
  status: z.enum(['executed', 'blocked', 'failed']),
  /** Name of the firewall check that blocked the action, when status is "blocked". */
  blockedBy: z.string().max(64).nullable(),
  error: z.strictObject({ code: z.string().max(64), message: ShortText }).nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  observationVersionAfter: z.number().int().nonnegative().nullable(),
});
export type ActionResult = z.infer<typeof ActionResult>;
