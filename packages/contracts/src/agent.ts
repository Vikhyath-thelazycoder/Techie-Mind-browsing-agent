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

/**
 * Largest file that can be put into a page's upload field (bytes). Bounded by Chrome's 64 MB
 * extension message limit once the file is base64-encoded.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Largest file the user can attach to ask about (read in the side panel; only text/images go on). */
export const MAX_ANALYSIS_BYTES = 50 * 1024 * 1024;

/** Most characters of file text kept for the local model (read in parts). */
export const MAX_DIGEST_TEXT = 400_000;

/**
 * What the side panel read from an attached file for "ask about this file": its text (PDF, text
 * files) and/or a few page images (images, scanned PDFs). Sent only to the LOCAL model.
 */
export const FileDigest = z.strictObject({
  name: z.string().trim().min(1).max(255),
  kind: z.enum(['pdf', 'image', 'text']),
  pages: z.number().int().min(0).max(100_000),
  text: z.string().max(MAX_DIGEST_TEXT),
  /** JPEG base64, at most 4 (images, or the first pages of a scanned PDF). */
  images: z
    .array(
      z.strictObject({
        base64: z.string().max(4 * 1024 * 1024),
        width: z.number().int().min(1).max(4096),
        height: z.number().int().min(1).max(4096),
      }),
    )
    .max(4),
});
export type FileDigest = z.infer<typeof FileDigest>;

/**
 * A file the user attached in the side panel (paperclip) for "upload it". It stays on this device:
 * it goes only into the page's own file field, after the firewall approved that upload.
 */
export const FileAttachment = z.strictObject({
  name: z.string().trim().min(1).max(255),
  mime: z.string().max(128),
  size: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  /** File content, base64. */
  base64: z.string().max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

export const RunTaskRequest = z.strictObject({
  type: z.literal('RUN_TASK'),
  text: z.string().trim().min(1).max(4000),
  mode: TaskMode,
  source: z.enum(['typed', 'voice', 'skill', 'rerun']),
  attachment: FileAttachment.nullable().optional(),
  /** The attached file as read by the panel, for questions about the file. */
  digest: FileDigest.nullable().optional(),
});
export type RunTaskRequest = z.infer<typeof RunTaskRequest>;

/** Sent periodically by the page while a task runs so the MV3 service worker stays alive. */
export const KeepAlive = z.strictObject({ type: z.literal('KEEPALIVE') });

/**
 * The user steering a running task (spec §26): pause at the next safe point (the task can be
 * resumed), or stop it for good. Both take effect between steps — never halfway through an action.
 */
export const ControlTaskRequest = z.strictObject({
  type: z.literal('CONTROL_TASK'),
  action: z.enum(['pause', 'stop']),
});
export type ControlTaskRequest = z.infer<typeof ControlTaskRequest>;

/**
 * Continue a task that handed over (spec §25: HUMAN_REQUIRED → PAUSED → USER_COMPLETED → RESUME).
 * `continue` — the user did their part (OTP, CAPTCHA, sign-in) or un-paused;
 * `approve` — the user confirms the one action the firewall asked about;
 * `discard` — forget the paused task.
 */
export const ResumeTaskRequest = z.strictObject({
  type: z.literal('RESUME_TASK'),
  taskId: Id,
  decision: z.enum(['continue', 'approve', 'discard']),
});
export type ResumeTaskRequest = z.infer<typeof ResumeTaskRequest>;

export const TaskPortRequest = z.discriminatedUnion('type', [
  RunTaskRequest,
  KeepAlive,
  ControlTaskRequest,
  ResumeTaskRequest,
]);
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
  'extract',
  'pick-item',
  'scroll',
  'history',
  'add-to-cart',
  'checkout',
  'fill-form',
  'submit-form',
  'summarize',
  'upload',
  'skill',
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

/**
 * What a task produced for the user besides its actions (Phase 5/6): a summary, extracted items, a
 * comparison table or a short list. Page-derived text is redacted before it is stored in history.
 */
export const TaskOutput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    title: z.string().max(200),
    text: z.string().max(8000),
    /** How it was produced: a model, or local extraction only. */
    source: z.enum(['model', 'extractive']),
  }),
  z.strictObject({
    kind: z.literal('items'),
    title: z.string().max(200),
    items: z
      .array(
        z.strictObject({
          title: z.string().max(300),
          price: z.number().nonnegative().nullable(),
          currency: z.string().max(8).nullable(),
          rating: z.number().min(0).max(5).nullable(),
          /** Origin + path only (no query string). */
          url: z.string().max(2048).nullable(),
          source: z.string().max(253).nullable(),
        }),
      )
      .max(60),
    /** Items seen before constraints were applied. */
    total: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('list'),
    title: z.string().max(200),
    entries: z.array(z.string().max(500)).max(100),
  }),
]);
export type TaskOutput = z.infer<typeof TaskOutput>;

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

/** Why a task stopped for the human, what they must do, and whether it can continue (spec §26). */
export const HandoverReason = z.enum([
  'otp',
  'captcha',
  'login',
  'payment',
  'confirmation',
  'paused',
  'other',
]);
export type HandoverReason = z.infer<typeof HandoverReason>;

export const HandoverInfo = z.strictObject({
  reason: HandoverReason,
  /** WHY IT STOPPED. */
  why: ShortText,
  /** WHAT THE USER NEEDS TO DO. */
  userAction: ShortText,
  /** WHEN IT CAN RESUME: true = after the user acts, the task continues where it stopped. */
  resumable: z.boolean(),
  /** The action the user is asked to approve (confirmation only). */
  approval: z.string().max(300).nullable().default(null),
  /** A resumable task is kept this long; afterwards it must be started again. */
  expiresAt: Timestamp.nullable(),
});
export type HandoverInfo = z.infer<typeof HandoverInfo>;

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
  /** What the task produced for the user (Phase 5/6); null when it only acted. */
  output: TaskOutput.nullable().default(null),
  /** Set when the task stopped for the human (HUMAN_REQUIRED / PAUSED). */
  handover: HandoverInfo.nullable().default(null),
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
