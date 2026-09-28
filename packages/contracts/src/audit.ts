import { z } from 'zod';
import { Id, Timestamp } from './primitives.js';

/** Structured observability events (master plan §60). */
export const AuditEventType = z.enum([
  'TASK_STARTED',
  'INTENT_RESOLVED',
  'TARGET_ROUTED',
  'NAVIGATION_STARTED',
  'OBSERVATION_CREATED',
  'PRIVACY_SCAN_COMPLETED',
  'TARGET_GROUNDED',
  'MODEL_CALLED',
  'ACTION_PROPOSED',
  'ACTION_ALLOWED',
  'ACTION_BLOCKED',
  'ACTION_EXECUTED',
  'VERIFICATION_COMPLETED',
  'HANDOVER_REQUIRED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'PRIVACY_EVENT',
  'SYSTEM',
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

/** Flat, primitive-only payload: nested objects cannot smuggle raw page content into logs. */
export const AuditData = z.record(
  z.string().max(64),
  z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]),
);
export type AuditData = z.infer<typeof AuditData>;

export const AuditEvent = z.strictObject({
  eventId: Id,
  type: AuditEventType,
  level: LogLevel,
  at: Timestamp,
  component: z.string().min(1).max(64),
  taskId: Id.nullable(),
  message: z.string().max(500),
  data: AuditData,
  /** Hash chaining (spec §47) — filled by the audit sink when enabled. */
  prevHash: z.string().max(128).nullable(),
  hash: z.string().max(128).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
