import { z } from 'zod';
import { AuditEvent } from './audit.js';
import { ACTION_TYPES } from './action.js';
import { IntentProfile, NavigationPolicy, Target, TargetSource } from './intent.js';
import { ModelUsage } from './model.js';
import { Domain, Id, ShortText, Timestamp } from './primitives.js';
import { TaskMode, TaskStatus } from './task.js';
import { RecoveryDecision } from './verification.js';

/** Long-lived port name used by extension pages to run tasks and stream progress. */
export const TASK_PORT = 'techie-mind/task';

export const RunTaskRequest = z.strictObject({
  type: z.literal('RUN_TASK'),
  text: z.string().trim().min(1).max(4000),
  mode: TaskMode,
  source: z.enum(['typed', 'voice', 'skill', 'rerun']),
});
export type RunTaskRequest = z.infer<typeof RunTaskRequest>;

/** Sent periodically by the page while a task runs so the MV3 service worker stays alive. */
export const KeepAlive = z.strictObject({ type: z.literal('KEEPALIVE') });

export const TaskPortRequest = z.discriminatedUnion('type', [RunTaskRequest, KeepAlive]);
export type TaskPortRequest = z.infer<typeof TaskPortRequest>;

/** Storage key for task history (TaskResult[], newest first). */
export const HISTORY_STORAGE_KEY = 'techieMind.history';
export const HISTORY_LIMIT = 50;

/** Per-stage latency, summed over all steps of a task (spec §81, master plan §43). */
export const StageTimings = z.strictObject({
  intentMs: z.number().nonnegative(),
  /** Inspecting the current tab/page before deciding where to act. */
  contextMs: z.number().nonnegative().default(0),
  routeMs: z.number().nonnegative(),
  /** Resolving a named website (candidate probing); 0 when not needed. */
  resolutionMs: z.number().nonnegative().default(0),
  /** Local privacy scanning (detection + sanitization) of every observation. */
  privacyMs: z.number().nonnegative().default(0),
  /** Action firewall evaluation (incl. the live probe it checks against). */
  firewallMs: z.number().nonnegative().default(0),
  navigationMs: z.number().nonnegative(),
  observationMs: z.number().nonnegative(),
  groundingMs: z.number().nonnegative(),
  actionMs: z.number().nonnegative(),
  verificationMs: z.number().nonnegative(),
  /** Time waiting for the page to react to an action (loads, SPA transitions, results rendering). */
  waitMs: z.number().nonnegative(),
  /** Time spent in text model tiers (Laya, local model, API). */
  modelMs: z.number().nonnegative().default(0),
  /** Visual fallback: capture + local redaction + vision model (0 when vision was not needed). */
  visionMs: z.number().nonnegative().default(0),
  totalMs: z.number().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
});
export type StageTimings = z.infer<typeof StageTimings>;

export const GoalKind = z.enum([
  'use-context',
  'navigate',
  'search',
  'open-result',
  'open-element',
]);
export type GoalKind = z.infer<typeof GoalKind>;

export const StepReport = z.strictObject({
  goal: GoalKind,
  description: ShortText,
  actionType: z.enum(ACTION_TYPES).nullable(),
  target: ShortText.nullable(),
  verified: z.boolean(),
  evidence: ShortText,
  attempts: z.number().int().min(0).max(20),
  recovery: z.array(RecoveryDecision).max(20),
});
export type StepReport = z.infer<typeof StepReport>;

/**
 * Raw result of fetching one candidate website during resolution (background fetch, no cookies).
 * `body` is a bounded prefix of the response text, used only to read the page's identity.
 */
export const WebsiteProbe = z.strictObject({
  url: z.string().max(2048),
  status: z.number().int().min(0).max(999).nullable(),
  finalUrl: z.string().max(2048).nullable(),
  body: z.string().max(300_000),
  error: z.string().max(200).nullable(),
  ms: z.number().nonnegative(),
});
export type WebsiteProbe = z.infer<typeof WebsiteProbe>;

export const CandidateVerdict = z.enum(['verified', 'plausible', 'rejected', 'unreachable']);
export type CandidateVerdict = z.infer<typeof CandidateVerdict>;

/** How a named website was resolved: every candidate with its verdict, and the choice. */
export const WebsiteResolution = z.strictObject({
  name: z.string().min(1).max(80),
  chosen: z.strictObject({ domain: Domain, url: z.string().max(2048) }).nullable(),
  ambiguous: z.boolean(),
  fromCache: z.boolean(),
  candidates: z
    .array(
      z.strictObject({
        domain: Domain,
        verdict: CandidateVerdict,
        score: z.number(),
        finalDomain: Domain.nullable(),
        evidence: ShortText,
      }),
    )
    .max(24),
});
export type WebsiteResolution = z.infer<typeof WebsiteResolution>;

/** The navigation decision made before acting (Phase 1 correction). */
export const NavigationDecision = z.strictObject({
  targetSource: TargetSource,
  navigationPolicy: NavigationPolicy,
  /** True when the task ran in the tab that was already open, without navigating it first. */
  reusedTab: z.boolean(),
  /** Origin (never the full URL) of the tab that was open when the task started. */
  contextOrigin: z.string().max(512).nullable(),
  resolution: WebsiteResolution.nullable(),
  reason: ShortText,
});
export type NavigationDecision = z.infer<typeof NavigationDecision>;

/** What the privacy engine and firewall did during a task — counts only, never values. */
export const PrivacySummary = z.strictObject({
  scans: z.number().int().nonnegative(),
  /** Sensitive items detected on pages (kept local). */
  detected: z.number().int().nonnegative(),
  byKind: z.record(z.string().max(32), z.number().int().nonnegative()),
  /** Page elements carrying instructions aimed at the agent (reported, never obeyed). */
  injectionsIgnored: z.number().int().nonnegative(),
  actionsBlocked: z.number().int().nonnegative(),
  /** Bytes of page content sent to any external service (Phase 2: always 0). */
  sentExternally: z.number().int().nonnegative(),
});
export type PrivacySummary = z.infer<typeof PrivacySummary>;

export const TaskResult = z.strictObject({
  taskId: Id,
  text: z.string().max(4000),
  status: TaskStatus,
  intent: IntentProfile.nullable(),
  target: Target.nullable(),
  navigation: NavigationDecision.nullable().default(null),
  privacy: PrivacySummary.nullable().default(null),
  /** Every model call of the task, in order (Phase 3). Empty when code handled everything. */
  models: z.array(ModelUsage).max(20).default([]),
  steps: z.array(StepReport).max(50),
  timings: StageTimings,
  tabId: z.number().int().nonnegative().nullable(),
  finalUrl: z.string().max(2048).nullable(),
  error: z.strictObject({ code: z.string().max(64), message: ShortText }).nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
});
export type TaskResult = z.infer<typeof TaskResult>;

/** Streamed from the background to the page that started the task. */
export const TaskPortMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('TASK_EVENT'), event: AuditEvent }),
  z.strictObject({ type: z.literal('TASK_RESULT'), result: TaskResult }),
  z.strictObject({ type: z.literal('TASK_ERROR'), code: z.string().max(64), message: ShortText }),
]);
export type TaskPortMessage = z.infer<typeof TaskPortMessage>;
