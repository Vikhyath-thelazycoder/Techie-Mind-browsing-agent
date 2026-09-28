import { z } from 'zod';
import { Action, ActionProposal, ActionResult } from './action.js';
import { AuditEvent } from './audit.js';
import { Intent, IntentProfile, Target } from './intent.js';
import { ModelDecision, ModelRequest } from './model.js';
import { Monitor, MonitorResult, Notification } from './monitor.js';
import { AccessibilityNode, DOMNode, Observation, VisualRegion } from './perception.js';
import { PrivacyFinding, SanitizedObservation } from './privacy.js';
import { Skill } from './skill.js';
import { Task } from './task.js';
import { HandoverState, RecoveryDecision, VerificationResult } from './verification.js';

export * from './primitives.js';
export * from './perception.js';
export * from './privacy.js';
export * from './intent.js';
export * from './task.js';
export * from './action.js';
export * from './model.js';
export * from './verification.js';
export * from './skill.js';
export * from './monitor.js';
export * from './audit.js';
export * from './messages.js';
export * from './agent.js';
export * from './fingerprint.js';

/**
 * Registry of every core contract required by master plan §9. Shared by the browser runtime and the
 * server (spec §64); `toJsonSchemas()` exports them for non-TypeScript consumers.
 */
export const CONTRACTS = {
  Task,
  Intent,
  IntentProfile,
  Target,
  Observation,
  DOMNode,
  AccessibilityNode,
  VisualRegion,
  PrivacyFinding,
  SanitizedObservation,
  ModelRequest,
  ModelDecision,
  Action,
  ActionProposal,
  ActionResult,
  VerificationResult,
  RecoveryDecision,
  HandoverState,
  Skill,
  Monitor,
  MonitorResult,
  Notification,
  AuditEvent,
} as const;

export type ContractName = keyof typeof CONTRACTS;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Validate untrusted input against a contract without throwing. */
export function parseContract<S extends z.ZodType>(
  schema: S,
  input: unknown,
): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** JSON Schema (draft 2020-12) for every registered contract. */
export function toJsonSchemas(): Record<ContractName, unknown> {
  const out = {} as Record<ContractName, unknown>;
  for (const [name, schema] of Object.entries(CONTRACTS) as [ContractName, z.ZodType][]) {
    out[name] = z.toJSONSchema(schema, { unrepresentable: 'any' });
  }
  return out;
}
