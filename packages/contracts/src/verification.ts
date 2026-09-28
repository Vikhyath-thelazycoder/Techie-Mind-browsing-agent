import { z } from 'zod';
import { ExpectedOutcome } from './action.js';
import { Id, ShortText, Timestamp } from './primitives.js';

/** Result of post-action verification (spec §28). Success is never inferred from dispatch alone. */
export const VerificationResult = z.strictObject({
  actionId: Id,
  verified: z.boolean(),
  strategy: ExpectedOutcome.shape.kind,
  evidence: ShortText,
  checkedAt: Timestamp,
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/** Bounded recovery ladder (spec §29): level 1 retry … level 6 human handover. */
export const RecoveryDecision = z
  .strictObject({
    actionId: Id,
    level: z.number().int().min(1).max(6),
    strategy: z.enum([
      'retry',
      'refresh-observation',
      'reground',
      'alternative-selector',
      'alternative-strategy',
      'handover',
    ]),
    attempt: z.number().int().min(1).max(6),
    reason: ShortText,
  })
  .refine((d) => (d.level === 6) === (d.strategy === 'handover'), {
    message: 'level 6 is exactly the handover strategy',
    path: ['strategy'],
  });
export type RecoveryDecision = z.infer<typeof RecoveryDecision>;

/** Human-handover state machine (spec §25–26). */
export const HandoverPhase = z.enum([
  'RUNNING',
  'HUMAN_REQUIRED',
  'PAUSED',
  'USER_COMPLETED',
  'RESUME',
]);
export type HandoverPhase = z.infer<typeof HandoverPhase>;

export const HandoverState = z.strictObject({
  taskId: Id,
  phase: HandoverPhase,
  reason: z
    .enum([
      'otp',
      'captcha',
      'payment',
      'login',
      'ambiguous',
      'verification-failed',
      'user-requested',
      'policy',
    ])
    .nullable(),
  /** WHAT the user needs to do. */
  userInstruction: ShortText.nullable(),
  /** WHEN the agent can resume. */
  resumeCondition: ShortText.nullable(),
  since: Timestamp,
});
export type HandoverState = z.infer<typeof HandoverState>;

/** Legal handover transitions. Anything else is a bug and must be rejected. */
export const HANDOVER_TRANSITIONS: Readonly<Record<HandoverPhase, readonly HandoverPhase[]>> = {
  RUNNING: ['HUMAN_REQUIRED', 'PAUSED'],
  HUMAN_REQUIRED: ['PAUSED'],
  PAUSED: ['USER_COMPLETED', 'RESUME'],
  USER_COMPLETED: ['RESUME'],
  RESUME: ['RUNNING'],
};

export function canTransition(from: HandoverPhase, to: HandoverPhase): boolean {
  return HANDOVER_TRANSITIONS[from].includes(to);
}
