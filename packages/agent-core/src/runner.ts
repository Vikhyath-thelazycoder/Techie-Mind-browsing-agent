import type { Settings } from '@techie-mind/config';
import {
  RecoveryDecision,
  SanitizedObservation,
  Target,
  TaskResult,
  type Action,
  type ActionArgs,
  type AuditEventType,
  type DOMNode,
  type ExecuteResponse,
  type ExpectedOutcome,
  type FileDigest,
  type IntentProfile,
  type ModelUsage,
  type NavigationDecision,
  type ExtractedItem,
  type Monitor,
  type SkillId,
  type TaskOutput,
  type Observation,
  type PrivacySummary,
  type ProbeResponse,
  type StageTimings,
  type StepReport,
  type HandoverInfo,
  type HandoverReason,
  type Task,
  type TaskStatus,
  type WebsiteProbe,
  type WebsiteResolution,
} from '@techie-mind/contracts';
import type { Intelligence, PageFacts } from '@techie-mind/models';
import { redactForLog, redactText, sanitizeObservation, TokenVault } from '@techie-mind/privacy';

/** Path of a URL with sensitive segments redacted (no query string, no fragment). */
function safePath(url: string): string {
  try {
    return redactForLog(new URL(url).pathname).slice(0, 2048) || '/';
  } catch {
    return '/';
  }
}
import {
  ActionFirewall,
  approvalKey,
  scanInjection,
  type FirewallContext,
  type FirewallDecision,
} from '@techie-mind/security';
import type { Logger } from '@techie-mind/telemetry';
import { bindAction, bindNavigation } from './binding.js';
import {
  currentQuery,
  describeNode,
  groundSearchInput,
  groundSearchSubmit,
  groundSearchToggle,
  rankResults,
} from './grounding.js';
import type { AgentHost } from './host.js';
import { isAmbiguous, isSmallTalk, judgeLaya, needsModel, profileFromModel } from './escalate.js';
import { ELEMENT_ENTITY, ELEMENT_LABEL_ENTITY } from './plan.js';
import { groundRegion, regionToPage, visionWorthTrying } from './vision.js';
import { formFields, planField, requestedFields, targetPlans } from './forms.js';
import { SKILL_ARG_ENTITY, SKILL_ENTITY } from './skills.js';
import type { BrowserData } from './host.js';
import { constraintsOf, resolveIntent, UNSUPPORTED_ENTITY } from './intent.js';
import { describeGoal, planGoals, type Goal } from './plan.js';
import {
  decideNavigation,
  discoveryTarget,
  needsContextFit,
  type ContextFit,
  type TabContext,
} from './router.js';
import {
  DEFAULT_SEARCH_SITE,
  FALLBACK_SEARCH_SITE,
  hostMatchesDomain,
  siteById,
  siteForDomain,
} from './sites.js';
import {
  challengeMessage,
  fieldHoldsQuery,
  isChallengePage,
  verifyNavigation,
  verifyOpenResult,
  verifySearch,
} from './verify.js';
import {
  cachedResolution,
  cacheResolution,
  resolutionAlternatives,
  resolveWebsite,
  websiteCandidates,
} from './website.js';

export interface RunnerDeps {
  host: AgentHost;
  logger: Logger;
  settings: Settings;
  /** Wall clock (epoch ms) for records. */
  now?: () => number;
  /** Monotonic clock (ms) for latency. */
  clock?: () => number;
  newId?: (prefix: string) => string;
  /** The local action firewall (one per background). */
  firewall?: ActionFirewall;
  /** Model tiers (Laya, local model / API). Absent = code only, exactly as in Phase 1–2. */
  intelligence?: Intelligence;
  /** The user's own instructions for skills whose output the local model writes (Settings → Skills). */
  skillInstructions?: Partial<Record<SkillId, string>>;
  /** The file the user attached (paperclip) for an upload; stays on this device. */
  attachment?: { fileRef: string; name: string; mime: string; size: number; base64: string } | null;
  /** The attached file as read by the side panel, for questions about it (local model only). */
  digest?: FileDigest | null;
  /** Pause / stop requests from the user, read between steps — never halfway through an action. */
  control?: { readonly pause: boolean; readonly stop: boolean };
  /** Receives the saved state of a task that stopped for the human and can continue (spec §25). */
  onCheckpoint?: (checkpoint: TaskCheckpoint) => void;
}

/**
 * Everything needed to continue a task where it stopped for the human: the remaining plan, the tab,
 * and the hosts the user's request allowed. Never holds page values — the vault is not saved.
 */
export interface TaskCheckpoint {
  task: Task;
  intent: IntentProfile | null;
  target: Target | null;
  navigation: NavigationDecision | null;
  tabId: number | null;
  allowedHosts: string[];
  goals: Goal[];
  /** The goal that stopped (it runs again on resume). */
  goalIndex: number;
  reason: HandoverReason;
  /** The one action a confirmation handover asks the user to approve. */
  approvalKey: string | null;
  /** Approvals already given earlier in this task. */
  approvals: string[];
  steps: StepReport[];
  output: TaskOutput | null;
  models: ModelUsage[];
  expiresAt: number;
}

/** A task stopped for the human is kept this long (spec §26: WHEN IT CAN RESUME). */
export const RESUME_TTL_MS = 30 * 60_000;

/** Handovers the task can continue after: the user does their part, then presses Continue. */
const RESUMABLE = new Set<HandoverReason>(['otp', 'captcha', 'login', 'confirmation', 'paused']);

const USER_ACTION: Record<HandoverReason, string> = {
  otp: 'Enter the one-time code on the page yourself, then press Continue.',
  captcha: 'Complete the human check on the page yourself, then press Continue.',
  login: 'Sign in on the page yourself, then press Continue.',
  payment: 'Payments are always yours: complete it yourself if you want to. The agent never pays.',
  confirmation: 'Approve to let the agent do this one action, or Stop.',
  paused: 'Press Continue when you want the agent to carry on, or Stop.',
  other: 'Check the page, then tell the agent what to do next.',
};

function handoverInfo(
  reason: HandoverReason,
  why: string,
  resumable: boolean,
  expiresAt: number | null,
  approval: string | null = null,
): HandoverInfo {
  return {
    reason,
    why: why.slice(0, 500),
    userAction:
      reason === 'confirmation' && approval
        ? `Approve "${approval.slice(0, 120)}" to let the agent do it once, or Stop.`
        : USER_ACTION[reason],
    resumable,
    approval: approval?.slice(0, 300) ?? null,
    expiresAt,
  };
}

function handoverReasonOf(decision: FirewallDecision): HandoverReason {
  switch (decision.handover) {
    case 'payment':
    case 'otp':
    case 'captcha':
    case 'login':
    case 'confirmation':
      return decision.handover;
    default:
      return 'other';
  }
}

type Stage =
  | 'intent'
  | 'context'
  | 'route'
  | 'resolution'
  | 'privacy'
  | 'firewall'
  | 'navigation'
  | 'observation'
  | 'grounding'
  | 'action'
  | 'verification'
  | 'wait'
  | 'model'
  | 'vision';

/** Codes that mean "the page changed under us": observe again and re-ground (recovery level 3). */
const REGROUND_CODES = new Set([
  'DOCUMENT_MISMATCH',
  'ORIGIN_MISMATCH',
  'STALE_OBSERVATION',
  'TARGET_MISSING',
  'TARGET_CHANGED',
  'TARGET_DETACHED',
]);

/** Firewall refusals that mean "the page moved on" — recoverable by re-observing. */
const STALE_CHECKS: Partial<Record<FirewallDecision['check'], ExecuteResponse['code']>> = {
  target: 'TARGET_CHANGED',
  origin: 'ORIGIN_MISMATCH',
  freshness: 'STALE_OBSERVATION',
};

/** Settle budgets. Kept small: deterministic steps should be fast (spec §81). */
/** Attached files are read in parts of this size (the local model's context), at most this many. */
const FILE_PART_CHARS = 24_000;
const FILE_PARTS = 12;
/** Commands that act on the open page or elsewhere, never on the attached file. */
const PAGE_ACTIONS = new Set([
  'upload_file',
  'scroll',
  'go_back',
  'go_forward',
  'add_to_cart',
  'checkout',
  'fill_form',
  'submit_form',
  'pick_item',
  'open_result',
  'play_result',
  'open_element',
  'play_element',
]);

/** Is this request about the attached file (rather than the page, a site, or an upload)? */
function isAboutFile(profile: IntentProfile, text: string): boolean {
  if (profile.action && PAGE_ACTIONS.has(profile.action)) return false;
  if (profile.targetDomain || profile.siteName) return false;
  // "summarize this page / the website": the page, not the file.
  if (profile.action === 'summarize' && /\b(?:page|site|website|tab|article)\b/i.test(text)) {
    return false;
  }
  if (profile.action === 'skill') return false;
  return true;
}

/** Hindi, Kannada, Tamil or Telugu script: translate the request to English before reading it. */
const INDIC_SCRIPT = /\p{Script=Devanagari}|\p{Script=Kannada}|\p{Script=Tamil}|\p{Script=Telugu}/u;
const NAVIGATION_SETTLE_MS = 20_000;
const ACTION_SETTLE_MS = 8_000;
/** Extra, bounded wait when a page is still an empty document after one settle window. */
const EMPTY_PAGE_WAIT_MS = 12_000;
/** How long a clicked result may leave its tab unchanged before we look for a tab it opened. */
const NEW_TAB_CHECK_MS = 2_000;

function largestTable<T extends { rows: unknown[] }>(
  tables: readonly T[] | undefined,
): T | undefined {
  return tables?.reduce<T | undefined>(
    (a, t) => (!a || t.rows.length > a.rows.length ? t : a),
    undefined,
  );
}

/** Words of a title or query, lowercased ("iPhone 15 (128 GB)" → iphone, 15, 128, gb). */
function termsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 || /\d/.test(w));
}

/** Every query term appears as a whole word in the title. */
function matchesAllTerms(title: string, query: string): boolean {
  const words = new Set(termsOf(title));
  return termsOf(query).every((t) => words.has(t));
}

/** Card noise that is not part of a product's name. */
const TITLE_NOISE =
  /\b(?:add to compare|not deliverable|currently unavailable|free delivery|sponsored|bestseller|limited time deal)\b/gi;
const SPONSORED_TITLE = /^\s*(?:sponsored|ad|promoted)\b/i;

/**
 * Items fit to compare: sponsored placements dropped, card noise removed from titles, and a price
 * of 0 treated as "no price" (seen live: "₹0 iOS Lock Screen iPhone 15").
 */
function cleanItems(items: ExtractedItem[]): ExtractedItem[] {
  return items
    .filter((i) => !SPONSORED_TITLE.test(i.title))
    .map((i) => ({
      ...i,
      title: i.title.replace(TITLE_NOISE, ' ').replace(/\s+/g, ' ').trim() || i.title,
      price: i.price !== null && i.price > 0 ? i.price : null,
    }));
}

/** Controls that start the payment flow (the agent never presses them). */
const CHECKOUT_LABEL =
  /check\s?out|proceed\s+to\s+(?:buy|pay|payment|checkout)|place\s+(?:your\s+)?order|pay\s+now|continue\s+to\s+payment/i;
/** Direct purchase on a product page — a payment step when there is no cart to go to first. */
const BUY_NOW_LABEL = /^buy\s+now$/i;

/** The tab still shows the same document at the same address (nothing happened there). */
function samePage(a: ProbeResponse, b: ProbeResponse): boolean {
  return a.url === b.url && a.documentId === b.documentId;
}
const MEDIA_WAIT_MS = 6_000;
const PLAYBACK_SAMPLE_MS = 1_200;
const RESULTS_WAIT_MS = 6_000;
const RESULTS_POLL_MS = 400;
/** Candidates confirmed in the real tab when every background probe was inconclusive. */
const IN_TAB_CANDIDATES = 2;
/** Second look at the open tab when the first found no search (page still rendering). */
const CONTEXT_SETTLE_MS = 3_000;
/** How long an automatic (JavaScript) access check may take to clear by itself. */
const CHALLENGE_WAIT_MS = 10_000;

class HandoverError extends Error {
  constructor(
    message: string,
    readonly reason: 'ambiguous' | 'verification-failed' | 'policy',
    /** What the human must do; null = nothing specific (the task cannot continue by itself). */
    readonly kind: HandoverReason | null = null,
  ) {
    super(message);
  }
}

class BudgetError extends Error {}

/**
 * Bounded recovery ladder (spec §29). Records typed RecoveryDecisions; never loops forever.
 */
class RecoveryLadder {
  readonly decisions: RecoveryDecision[] = [];
  readonly #used = new Set<string>();

  constructor(
    private readonly emit: (decision: RecoveryDecision) => void,
    private readonly max = 6,
  ) {}

  used(key: string): boolean {
    return this.#used.has(key);
  }

  get exhausted(): boolean {
    return this.decisions.length >= this.max - 1;
  }

  decide(
    level: 1 | 2 | 3 | 4 | 5,
    strategy: RecoveryDecision['strategy'],
    key: string,
    reason: string,
    actionId: string,
  ): void {
    if (this.exhausted)
      throw new HandoverError(`Recovery budget exhausted: ${reason}`, 'verification-failed');
    this.#used.add(key);
    const decision = RecoveryDecision.parse({
      actionId,
      level,
      strategy,
      attempt: this.decisions.length + 1,
      reason: reason.slice(0, 500),
    });
    this.decisions.push(decision);
    this.emit(decision);
  }

  handover(reason: string, actionId: string): RecoveryDecision {
    const decision = RecoveryDecision.parse({
      actionId,
      level: 6,
      strategy: 'handover',
      attempt: Math.min(this.decisions.length + 1, 6),
      reason: reason.slice(0, 500),
    });
    this.decisions.push(decision);
    this.emit(decision);
    return decision;
  }
}

export async function runTask(task: Task, deps: RunnerDeps): Promise<TaskResult> {
  return new TaskRun(task, deps).run();
}

/**
 * Continue a task that stopped for the human, at the step that stopped. `approve` also lifts the
 * confirmation for the one action the user was asked about; everything else is checked as before.
 */
export async function resumeTask(
  checkpoint: TaskCheckpoint,
  decision: 'continue' | 'approve',
  deps: RunnerDeps,
  taskId: string,
): Promise<TaskResult> {
  return new TaskRun({ ...checkpoint.task, taskId }, deps).resume(checkpoint, decision);
}

class TaskRun {
  readonly #now: () => number;
  readonly #clock: () => number;
  readonly #newId: (prefix: string) => string;
  readonly #timings: StageTimings = {
    intentMs: 0,
    contextMs: 0,
    routeMs: 0,
    resolutionMs: 0,
    privacyMs: 0,
    firewallMs: 0,
    navigationMs: 0,
    observationMs: 0,
    groundingMs: 0,
    actionMs: 0,
    verificationMs: 0,
    waitMs: 0,
    modelMs: 0,
    visionMs: 0,
    totalMs: 0,
    modelCalls: 0,
    observations: 0,
  };
  readonly #steps: StepReport[] = [];
  readonly #startedAt: number;
  readonly #startClock: number;
  #tabId: number | null = null;
  #actions = 0;
  #intent: IntentProfile | null = null;
  #target: Target | null = null;
  #navigation: NavigationDecision | null = null;
  /** Task-scoped, memory-only vault: sensitive page values are tokenized here, never exported. */
  readonly #vault = new TokenVault();
  readonly #firewall: ActionFirewall;
  /** Hosts this task may navigate to — only ever derived from the user's request and its routing. */
  readonly #allowedHosts = new Set<string>();
  /** Runtime receipt time of each observation (freshness is judged on the runtime's clock). */
  readonly #observedAt = new Map<string, number>();
  /** Sensitive-item counts per document (max per kind over its observations and page scan). */
  readonly #docCounts = new Map<string, Record<string, number>>();
  readonly #docInjections = new Map<string, Set<string>>();
  readonly #pageInjections = new Map<string, number>();
  readonly #privacy: PrivacySummary = {
    scans: 0,
    detected: 0,
    byKind: {},
    injectionsIgnored: 0,
    actionsBlocked: 0,
    sentExternally: 0,
  };
  #finalUrl: string | null = null;
  #inNavigation = false;
  readonly #models: ModelUsage[] = [];
  /** What the task produced for the user (items, a summary); null when it only acted. */
  #output: TaskOutput | null = null;
  /** Which tier proposed the plan's actions (the firewall still authorizes each one). */
  #proposer: 'deterministic' | 'laya' | 'qwen' | 'api' | 'vision' = 'deterministic';
  /** Why the task stopped for the human (shown to the user). */
  #handover: HandoverInfo | null = null;
  /** The kind of handover the last failed goal ended with. */
  #lastHandoverKind: HandoverReason | null = null;
  /** The action the firewall last asked the user to confirm. */
  #pendingApproval: { key: string; label: string } | null = null;
  /** Actions the user approved after a confirmation handover. */
  readonly #approvals = new Set<string>();

  constructor(
    private readonly task: Task,
    private readonly deps: RunnerDeps,
  ) {
    this.#now = deps.now ?? Date.now;
    this.#clock = deps.clock ?? (() => performance.now());
    let counter = 0;
    this.#newId = deps.newId ?? ((prefix) => `${prefix}-${task.taskId}-${++counter}`);
    this.#firewall = deps.firewall ?? new ActionFirewall();
    this.#startedAt = this.#now();
    this.#startClock = this.#clock();
  }

  // ── infrastructure ───────────────────────────────────────────────────────────────────────

  #emit(
    type: AuditEventType,
    message: string,
    data: Record<string, unknown> = {},
    level: 'info' | 'warn' = 'info',
  ) {
    this.deps.logger.event(type, message, { taskId: this.task.taskId, level, data });
  }

  async #timed<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
    const start = this.#clock();
    try {
      return await fn();
    } finally {
      this.#timings[`${stage}Ms`] += this.#clock() - start;
    }
  }

  #checkBudget() {
    if (this.#actions >= this.deps.settings.agent.maxSteps) {
      throw new BudgetError(`Step limit reached (${this.deps.settings.agent.maxSteps} actions).`);
    }
    if (this.#clock() - this.#startClock > this.deps.settings.agent.taskTimeoutMs) {
      throw new BudgetError(`Task timed out after ${this.deps.settings.agent.taskTimeoutMs} ms.`);
    }
  }

  get #tab(): number {
    if (this.#tabId === null) throw new Error('no agent tab');
    return this.#tabId;
  }

  async #observe(): Promise<Observation> {
    const observationId = this.#newId('obs');
    const start = this.#clock();
    const obs = await this.#timed('observation', () =>
      this.deps.host.observe(this.#tab, this.task.taskId, observationId),
    );
    this.#timings.observations += 1;
    this.#emit('OBSERVATION_CREATED', `Observed ${obs.origin}${new URL(obs.url).pathname}`, {
      observationId,
      version: obs.version,
      domNodes: obs.domNodes.length,
      a11yNodes: obs.a11yNodes.length,
      ms: Math.round(this.#clock() - start),
    });
    this.#observedAt.set(obs.observationId, this.#now());
    await this.#timed('privacy', () => this.#privacyScan(obs));
    return obs;
  }

  /**
   * Local privacy scan of every observation: detect and tokenize sensitive values (they stay in the
   * task vault), and find page text that tries to instruct the agent. Only counts are reported.
   */
  async #privacyScan(obs: Observation) {
    const { stats, ms } = sanitizeObservation(obs, this.#vault, this.#clock);
    const injection = scanInjection(obs);
    // Whole-page text scan inside the page (counts only), once per document.
    const firstLook = !this.#docCounts.has(obs.documentId);
    const page = firstLook ? await this.deps.host.scanPage?.(this.#tab).catch(() => null) : null;
    const counts = this.#docCounts.get(obs.documentId) ?? {};
    for (const source of [stats.byKind, page?.byKind ?? {}]) {
      for (const [kind, n] of Object.entries(source))
        counts[kind] = Math.max(counts[kind] ?? 0, n ?? 0);
    }
    this.#docCounts.set(obs.documentId, counts);
    const seenInjections = this.#docInjections.get(obs.documentId) ?? new Set<string>();
    injection.nodeIds.forEach((id) => seenInjections.add(id));
    this.#docInjections.set(obs.documentId, seenInjections);
    this.#privacy.scans += 1;
    this.#privacy.byKind = {};
    for (const docCounts of this.#docCounts.values()) {
      for (const [kind, n] of Object.entries(docCounts)) {
        this.#privacy.byKind[kind] = (this.#privacy.byKind[kind] ?? 0) + n;
      }
    }
    this.#privacy.detected = Object.values(this.#privacy.byKind).reduce((a, b) => a + b, 0);
    if (page) this.#pageInjections.set(obs.documentId, page.injections);
    this.#privacy.injectionsIgnored = [...this.#docInjections.entries()].reduce(
      (a, [doc, set]) => a + Math.max(set.size, this.#pageInjections.get(doc) ?? 0),
      0,
    );
    const pageInjections = page?.injections ?? 0;
    const docTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const kinds = Object.entries(counts)
      .map(([k, n]) => `${k}×${n}`)
      .join(', ');
    this.#emit(
      'PRIVACY_SCAN_COMPLETED',
      docTotal > 0
        ? `${docTotal} sensitive item(s) on this page detected and kept local (${kinds})`
        : 'No sensitive data detected',
      {
        observationId: obs.observationId,
        detected: docTotal,
        pageScanned: page !== null && page !== undefined,
        kinds,
        injections: injection.nodeIds.size,
        ms: Math.round(ms * 10) / 10,
      },
    );
    const attempts = Math.max(injection.nodeIds.size, pageInjections);
    if (attempts > 0) {
      this.#emit(
        'PRIVACY_EVENT',
        `Ignored ${attempts} piece(s) of page text that try to instruct the agent${injection.hidden ? ` (${injection.hidden} hidden)` : ''}`,
        { injections: attempts, hidden: injection.hidden },
        'warn',
      );
    }
  }

  /** Run the action firewall against the tab's live state. */
  async #authorize(
    action: Action,
    obs: Observation | null,
    confirmAt: FirewallContext['confirmAt'] = this.deps.settings.agent.confirmAtRisk,
  ): Promise<FirewallDecision> {
    return this.#timed('firewall', async () => {
      const live = await this.deps.host.probe(this.#tab, null).catch(() => null);
      const decision = this.#firewall.evaluate(action, {
        taskId: this.task.taskId,
        tabId: this.#tab,
        observation: obs,
        live,
        // The English translation is made from the user's words only (never page text), so text
        // taken from it is the user's too.
        userText:
          this.#requestText && this.#requestText !== this.task.text
            ? `${this.task.text}\n${this.#requestText}`
            : this.task.text,
        allowedHosts: [...this.#allowedHosts],
        confirmAt,
        now: this.#now(),
        vault: this.#vault,
        approvals: this.#approvals,
        attachedFileRef: this.deps.attachment?.fileRef ?? null,
        ...(obs ? { observedAt: this.#observedAt.get(obs.observationId) ?? this.#now() } : {}),
      });
      if (!decision.allowed && decision.handover === 'confirmation') {
        const b = action.binding.target;
        const node =
          b?.kind === 'element'
            ? (obs?.domNodes.find((n) => n.nodeId === b.elementId) ?? null)
            : null;
        const label = (node?.name ?? node?.text ?? action.args.type).trim() || action.args.type;
        this.#pendingApproval = {
          key: approvalKey(action, node, obs?.url ?? live?.url ?? null),
          label: `${action.args.type.toLowerCase()} "${label.slice(0, 100)}"`,
        };
      }
      if (decision.allowed) {
        this.#emit(
          'ACTION_ALLOWED',
          `Firewall: ${decision.passed.length} checks passed · risk ${decision.risk?.level ?? '-'}`,
          {
            actionId: action.actionId,
            risk: decision.risk?.level ?? null,
            checks: decision.passed.join(','),
            observationId: action.binding.observationId,
            documentId: action.binding.documentId,
            tabId: action.binding.tabId,
          },
        );
      } else {
        this.#privacy.actionsBlocked += 1;
        this.#emit(
          'ACTION_BLOCKED',
          `Firewall blocked ${action.args.type} at "${decision.check}": ${decision.reasons.join('; ')}`,
          {
            actionId: action.actionId,
            check: decision.check,
            risk: decision.risk?.level ?? null,
            handover: decision.handover,
          },
          'warn',
        );
      }
      return decision;
    });
  }

  /** Browser-level navigation that is authorized by the firewall first. */
  async #navigateGuarded(tab: number, url: string, what: string): Promise<void> {
    const current = await this.deps.host.probe(tab, null).catch(() => null);
    const action = bindNavigation({
      actionId: this.#newId('act'),
      taskId: this.task.taskId,
      tabId: tab,
      observationId: this.#newId('tabstate'),
      current,
      url,
      now: this.#now(),
    });
    const decision = await this.#authorize(action, null);
    if (!decision.allowed) this.#refuse(decision, what);
    await this.deps.host.navigate(tab, url);
  }

  /** A firewall refusal that is not a stale-page problem stops the task and hands over. */
  #refuse(decision: FirewallDecision, what: string): never {
    const reason = decision.reasons.join('; ');
    const message =
      decision.handover === 'payment'
        ? `Stopped before ${what}: it would authorize a payment (${reason}). Complete it yourself if you want to.`
        : decision.handover === 'otp'
          ? `Stopped before ${what}: one-time codes are entered by you (${reason}).`
          : decision.handover === 'captcha'
            ? `Stopped before ${what}: a human-verification challenge must be completed by you.`
            : decision.handover === 'login'
              ? `Stopped before ${what}: signing in is done by you (${reason}).`
              : decision.handover === 'confirmation'
                ? `Stopped before ${what}: ${reason}.`
                : `Blocked by the action firewall (${decision.check}): ${reason}.`;
    throw new HandoverError(message, 'policy', handoverReasonOf(decision));
  }

  async #openedTabs(): Promise<Set<number>> {
    const list = await this.deps.host.openedTabs?.(this.#tab).catch(() => []);
    return new Set(list ?? []);
  }

  /**
   * Switch the task to a tab the last click opened, if any. Verification then judges that tab like
   * a same-tab navigation, so the result is never clicked twice.
   */
  async #adoptOpenedTab(openedBefore: Set<number>): Promise<ProbeResponse | null> {
    const host = this.deps.host;
    if (!host.openedTabs || !host.adoptTab) return null;
    const fresh = [...(await this.#openedTabs())].find((id) => !openedBefore.has(id));
    if (fresh === undefined) return null;
    const from = this.#tab;
    await host.adoptTab(fresh);
    this.#tabId = fresh;
    this.#emit('NAVIGATION_STARTED', 'The result opened in a new tab — continuing there', {
      reason: 'new-tab',
      fromTabId: from,
      tabId: fresh,
    });
    return this.#settle(null, ACTION_SETTLE_MS);
  }

  async #settle(since: ProbeResponse | null, timeoutMs: number): Promise<ProbeResponse | null> {
    const settle = () => this.deps.host.settle(this.#tab, { since, timeoutMs });
    // Navigation settling is part of the navigation stage; every other settle is page wait time.
    const probe = this.#inNavigation ? await settle() : await this.#timed('wait', settle);
    if (probe) this.#finalUrl = probe.url;
    return probe;
  }

  /** Bind, announce and execute one element action through the host. */
  async #execute(
    obs: Observation,
    target: DOMNode | null,
    args: ActionArgs,
    reason: string,
    expectedOutcome: ExpectedOutcome,
    confidence: number,
    options: { trusted?: boolean; confirmAt?: FirewallContext['confirmAt'] } = {},
  ): Promise<{ action: Action; result: ExecuteResponse }> {
    this.#checkBudget();
    const action = bindAction({
      actionId: this.#newId('act'),
      taskId: this.task.taskId,
      tabId: this.#tab,
      observation: obs,
      target,
      args,
      reason,
      confidence,
      expectedOutcome,
      proposedBy: this.#proposer,
      now: this.#now(),
    });
    this.#emit('ACTION_PROPOSED', `${args.type}${target ? ` ${describeNode(target)}` : ''}`, {
      actionId: action.actionId,
      actionType: args.type,
      proposedBy: this.#proposer,
    });
    this.#actions += 1;
    const decision = await this.#authorize(action, obs, options.confirmAt);
    if (!decision.allowed) {
      const recoverable = STALE_CHECKS[decision.check];
      if (!recoverable)
        this.#refuse(decision, `${args.type}${target ? ` ${describeNode(target)}` : ''}`);
      // The page changed under the plan: report it like the page-side check would, so the
      // recovery ladder re-observes and re-grounds (L3).
      return {
        action,
        result: {
          type: 'EXECUTE_RESULT',
          actionId: action.actionId,
          status: 'rejected',
          code: recoverable,
          message: `firewall: ${decision.reasons.join('; ')}`.slice(0, 500),
          valueAfter: null,
          versionAfter: 0,
          deferred: false,
        },
      };
    }
    const start = this.#clock();
    // A vault token is resolved to its value only now, after the firewall authorized the action.
    const token = args.type === 'TYPE' && 'vaultToken' in args.input ? args.input.vaultToken : null;
    const value = token ? this.#vault.resolve(token, { consume: false }) : null;
    if (token && value === null) {
      return {
        action,
        result: {
          type: 'EXECUTE_RESULT',
          actionId: action.actionId,
          status: 'failed',
          code: null,
          message: 'the saved value is no longer available',
          valueAfter: null,
          versionAfter: 0,
          deferred: false,
        },
      };
    }
    const trustedClick =
      options.trusted && args.type === 'CLICK' && target && this.deps.host.trustedClick
        ? this.deps.host.trustedClick.bind(this.deps.host)
        : null;
    const result = await this.#timed('action', async () => {
      if (
        trustedClick &&
        target &&
        (await trustedClick(this.#tab, target.nodeId).catch(() => false))
      ) {
        this.#emit('SYSTEM', 'Clicked with trusted browser input (so media may start with sound)', {
          actionId: action.actionId,
        });
        return {
          type: 'EXECUTE_RESULT' as const,
          actionId: action.actionId,
          status: 'executed' as const,
          code: null,
          message: 'trusted click',
          valueAfter: null,
          versionAfter: 0,
          deferred: true,
        };
      }
      const file =
        args.type === 'UPLOAD' && this.deps.attachment?.fileRef === args.fileRef
          ? this.deps.attachment
          : null;
      if (file) {
        return this.deps.host.execute(this.#tab, action, undefined, {
          fileRef: file.fileRef,
          name: file.name,
          mime: file.mime,
          base64: file.base64,
        });
      }
      return token && value !== null
        ? this.deps.host.execute(this.#tab, action, { vaultToken: token, text: value })
        : this.deps.host.execute(this.#tab, action);
    });
    const ms = Math.round(this.#clock() - start);
    if (result.status === 'executed') {
      this.#emit('ACTION_EXECUTED', `${args.type} executed`, { actionId: action.actionId, ms });
    } else {
      this.#emit(
        'ACTION_BLOCKED',
        `${args.type} ${result.status}: ${result.code ?? ''} ${result.message}`,
        { actionId: action.actionId, code: result.code, ms },
        'warn',
      );
    }
    return { action, result };
  }

  #grounded(kind: string, node: DOMNode, score: number, reasons: string[]) {
    this.#emit('TARGET_GROUNDED', `${kind}: ${describeNode(node)}`, {
      nodeId: node.nodeId,
      score,
      reasons: reasons.join(', '),
    });
  }

  #verified(verified: boolean, evidence: string, goal: Goal) {
    this.#emit(
      'VERIFICATION_COMPLETED',
      `${verified ? 'Verified' : 'Not verified'}: ${evidence}`,
      { goal: goal.kind, verified },
      verified ? 'info' : 'warn',
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────────────────

  /** The request as rules and models read it: English, after translation when needed. */
  #requestText = '';

  /**
   * Indian-language requests → English on the active model, before rules or other models read
   * them ("ಯುಟ್ಯೂಬ್ ಓಪನ್ ಮಾಡಿ ಕನ್ನಡ ಸಾಂಗ್ಸ್ ಪ್ಲೇ ಮಾಡು" → "open YouTube and play Kannada songs").
   * The user's language is kept for the reply. Without a model, the local word rules still apply.
   */
  async #toEnglish(original: IntentProfile): Promise<IntentProfile> {
    const intelligence = this.deps.intelligence;
    const indic = INDIC_SCRIPT.test(this.task.text);
    const unsure = needsModel(original);
    // The word rules fully understood it and left no Indian-script words to type: exact and instant.
    const rulesDone =
      !unsure && !INDIC_SCRIPT.test(`${original.query ?? ''} ${original.siteName ?? ''}`);
    if (!intelligence?.translate || rulesDone || (!indic && original.language === 'en')) {
      return original;
    }
    if (!indic && !unsure) return original;
    const { text: modelText } = redactText(this.task.text, this.#vault);
    const answer = await this.#timed('model', () =>
      intelligence.translate!({
        taskId: this.task.taskId,
        text: modelText,
        intent: { ...original, query: null, siteName: null, entities: [], constraints: [] },
      }),
    );
    this.#recordModel(answer.usage);
    if (!answer.value) return original;
    this.#emit('SYSTEM', `Translated to English: "${answer.value.slice(0, 200)}"`, {
      translated: true,
    });
    // Placeholders stand for the user's own words: restore them locally.
    this.#requestText = answer.value.replace(
      /\b[A-Z]{2,24}_\d{3}\b/g,
      (t) => this.#vault.resolve(t, { consume: false }) ?? t,
    );
    const english = resolveIntent(this.#requestText).profile;
    // The rules saw a play verb (ಹಾಕು, चलाओ …) that the translation softened to "search".
    const play = original.action === 'search_and_play' && english.action === 'search';
    return {
      ...english,
      ...(play ? { intent: 'media_playback' as const, action: 'search_and_play' } : {}),
      language: original.language,
    };
  }

  async run(): Promise<TaskResult> {
    this.#emit('TASK_STARTED', this.task.text, { source: this.task.source, mode: this.task.mode });
    this.#requestText = this.task.text;
    try {
      const original = await this.#timed(
        'intent',
        async () => resolveIntent(this.task.text).profile,
      );
      const code = await this.#toEnglish(original);
      // A file is attached and the request is about it (not "upload it", another site, or the page).
      if (this.deps.digest && isAboutFile(code, this.#requestText)) {
        return await this.#analyzeFile(this.deps.digest, code);
      }
      // Where to act — decided BEFORE any navigation, from the wording and the open tab.
      const context = await this.#timed('context', () => this.deps.host.currentContext());
      // Code first; only a reading code is unsure of goes to the model tiers.
      const escalated = await this.#escalate(code, context);
      if ('finish' in escalated) return escalated.finish;
      const profile = escalated.profile;
      this.#intent = profile;
      this.#emit(
        'INTENT_RESOLVED',
        `${profile.intent}${profile.query ? ` · "${profile.query}"` : ''} (${profile.resolvedBy})`,
        {
          intent: profile.intent,
          action: profile.action,
          domain: profile.targetDomain,
          query: profile.query,
          language: profile.language,
          confidence: profile.confidence,
          resolvedBy: profile.resolvedBy,
          modelCalls: this.#timings.modelCalls,
        },
      );

      // The open tab's site is part of the user's context; recovery may return to it.
      if (context) this.#allowedHosts.add(context.host);
      if (profile.action === 'skill') return await this.#runSkill(profile, context);
      const fit =
        context && needsContextFit(profile, context) ? await this.#assessContext(context) : null;
      const decision = await this.#timed('route', async () =>
        decideNavigation(profile, context, fit),
      );
      if (!decision.ok) {
        return this.#finish('FAILED', { code: decision.code, message: decision.message });
      }

      let target = decision.target;
      let targetSource = decision.targetSource;
      let navigationPolicy = decision.navigationPolicy;
      let resolution: WebsiteResolution | null = null;
      let discovery = false;
      // The tab the task works in: the open tab when reusing it (or told to act in it), else a
      // fresh/reusable one — chosen lazily so website resolution can confirm candidates in it.
      const useContextTab = (decision.reuse || decision.inContextTab) && context !== null;
      const ensureTab = async () =>
        (this.#tabId ??= useContextTab ? context!.tabId : await this.deps.host.prepareTab());
      let alreadyOnTarget = decision.reuse;
      if (decision.resolveName) {
        const resolved = await this.#timed('resolution', () =>
          this.#resolveWebsite(decision.resolveName!, ensureTab),
        );
        resolution = resolved.resolution;
        alreadyOnTarget = resolved.inTab;
        if (resolution.chosen && !resolution.ambiguous) {
          target = Target.parse({
            domain: resolution.chosen.domain,
            url: resolution.chosen.url,
            adapterId: siteForDomain(resolution.chosen.domain)?.id ?? null,
            reason: 'resolved-website',
          });
        } else if (resolution.ambiguous) {
          this.#navigation = this.#record(decision, context, resolution, 'ambiguous website');
          const options = resolutionAlternatives(resolution);
          const message = `"${resolution.name}" matches more than one website (${options.join(', ')}). Say which one, for example "open ${options[0] ?? 'the site'}".`;
          this.#emit('HANDOVER_REQUIRED', message, { reason: 'ambiguous-website' }, 'warn');
          return this.#finish('HUMAN_REQUIRED', { code: 'AMBIGUOUS_WEBSITE', message });
        } else {
          // Last resort: nothing could be confirmed safely — let a search engine show options.
          target = discoveryTarget();
          targetSource = 'SEARCH_DISCOVERY';
          navigationPolicy = 'SEARCH_AS_LAST_RESORT';
          discovery = true;
        }
      }
      if (!target) return this.#finish('FAILED', { code: 'NO_TARGET', message: 'No destination.' });
      this.#target = target;
      // Where the user's request routes to is the only other place this task may navigate.
      this.#allowedHosts.add(target.domain);
      this.#allowedHosts.add(new URL(target.url).hostname);
      this.#intent = { ...profile, targetSource, navigationPolicy };
      this.#navigation = this.#record(
        { ...decision, targetSource, navigationPolicy },
        context,
        resolution,
        discovery ? `no website could be confirmed for "${decision.resolveName}"` : decision.reason,
      );
      this.#emit(
        'TARGET_ROUTED',
        `${decision.reuse ? 'Reuse current tab' : 'Target'}: ${target.domain} · ${targetSource} · ${navigationPolicy} — ${this.#navigation.reason}`,
        {
          domain: target.domain,
          url: target.url,
          reason: target.reason,
          targetSource,
          navigationPolicy,
          reusedTab: decision.reuse,
          contextOrigin: context?.origin ?? null,
        },
      );

      const planned = discovery
        ? planGoals(
            { ...profile, action: 'search', query: decision.resolveName, ordinal: null },
            target,
          )
        : planGoals(profile, target, alreadyOnTarget);
      if (!planned.ok)
        return this.#finish('FAILED', { code: planned.code, message: planned.message });
      const plan = planned;

      await ensureTab();
      const stopped = await this.#runGoals(plan.goals, 0);
      if (stopped) return stopped;
      if (discovery) {
        const message = `Could not confirm an official website for "${decision.resolveName}". Search results are open so you can choose the right one.`;
        this.#emit('HANDOVER_REQUIRED', message, { reason: 'website-not-resolved' }, 'warn');
        return this.#finish('HUMAN_REQUIRED', { code: 'WEBSITE_NOT_RESOLVED', message });
      }
      return this.#finish('COMPLETED', null);
    } catch (error) {
      const code = error instanceof BudgetError ? 'BUDGET_EXCEEDED' : 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      return this.#finish('FAILED', { code, message });
    }
  }

  /**
   * Run the plan from `from`. Pause and stop are honoured between steps. A goal that stops for the
   * human either saves a checkpoint (OTP, CAPTCHA, sign-in, confirmation: the task continues after
   * the user acts) or ends the task (payment: always the user's).
   */
  async #runGoals(goals: Goal[], from: number): Promise<TaskResult | null> {
    for (let i = from; i < goals.length; i++) {
      const goal = goals[i]!;
      if (this.deps.control?.stop) {
        this.#emit('SYSTEM', 'Stopped by you', { goal: goal.kind }, 'warn');
        return this.#finish('CANCELLED', {
          code: 'STOPPED_BY_USER',
          message: 'You stopped the task.',
        });
      }
      if (this.deps.control?.pause) {
        return this.#suspend('paused', `Paused before: ${describeGoal(goal)}`, goals, i);
      }
      const report = await this.#achieve(goal);
      this.#steps.push(report);
      if (!report.verified) {
        const handover = report.recovery.some((r) => r.strategy === 'handover');
        this.#emit('HANDOVER_REQUIRED', report.evidence, { goal: goal.kind }, 'warn');
        const message = `${describeGoal(goal)}: ${report.evidence}`;
        const kind = handover ? this.#lastHandoverKind : null;
        if (kind && RESUMABLE.has(kind)) return this.#suspend(kind, message, goals, i);
        if (kind) this.#handover = handoverInfo(kind, report.evidence, false, null);
        return this.#finish(handover ? 'HUMAN_REQUIRED' : 'FAILED', {
          code: 'GOAL_NOT_VERIFIED',
          message,
        });
      }
    }
    return null;
  }

  /** Stop for the human and keep what is needed to continue (HUMAN_REQUIRED → PAUSED → RESUME). */
  #suspend(reason: HandoverReason, why: string, goals: Goal[], index: number): TaskResult {
    const expiresAt = this.#now() + RESUME_TTL_MS;
    const approval = reason === 'confirmation' ? this.#pendingApproval : null;
    this.#handover = handoverInfo(reason, why, true, expiresAt, approval?.label ?? null);
    this.deps.onCheckpoint?.({
      task: this.task,
      intent: this.#intent,
      target: this.#target,
      navigation: this.#navigation,
      tabId: this.#tabId,
      allowedHosts: [...this.#allowedHosts],
      goals,
      goalIndex: index,
      reason,
      approvalKey: approval?.key ?? null,
      approvals: [...this.#approvals],
      steps: [...this.#steps],
      output: this.#output,
      models: [...this.#models],
      expiresAt,
    });
    this.#emit(
      'HANDOVER_REQUIRED',
      `${this.#handover.why} — ${this.#handover.userAction}`,
      { reason, resumable: true },
      'warn',
    );
    return this.#finish(reason === 'paused' ? 'PAUSED' : 'HUMAN_REQUIRED', {
      code: reason === 'paused' ? 'PAUSED' : 'HUMAN_REQUIRED',
      message: why,
    });
  }

  async resume(cp: TaskCheckpoint, decision: 'continue' | 'approve'): Promise<TaskResult> {
    this.#emit('TASK_STARTED', `Continuing: ${this.task.text}`, {
      source: this.task.source,
      mode: this.task.mode,
      resumed: true,
      reason: cp.reason,
    });
    try {
      if (this.#now() > cp.expiresAt) {
        return this.#finish('FAILED', {
          code: 'RESUME_EXPIRED',
          message: 'This paused task expired. Ask again to start it fresh.',
        });
      }
      this.#intent = cp.intent;
      // A translated request: its English query was read from the user's words before the pause.
      this.#requestText = cp.intent?.query ?? this.task.text;
      this.#target = cp.target;
      this.#navigation = cp.navigation;
      this.#tabId = cp.tabId;
      this.#output = cp.output;
      for (const host of cp.allowedHosts) this.#allowedHosts.add(host);
      for (const key of cp.approvals) this.#approvals.add(key);
      if (decision === 'approve' && cp.approvalKey) this.#approvals.add(cp.approvalKey);
      this.#steps.push(...cp.steps.slice(-40));
      this.#models.push(...cp.models.slice(-10));
      if (this.#tabId !== null) {
        const live = await this.deps.host.probe(this.#tabId, null).catch(() => null);
        if (!live) {
          return this.#finish('FAILED', {
            code: 'TAB_CLOSED',
            message: 'The tab the task was working in is closed or no longer shows a web page.',
          });
        }
      }
      this.#emit(
        'SYSTEM',
        decision === 'approve'
          ? 'You approved the action — continuing'
          : `Continuing after ${cp.reason === 'paused' ? 'the pause' : 'your step'}`,
        { reason: cp.reason, goal: cp.goals[cp.goalIndex]?.kind ?? null },
      );
      const stopped = await this.#runGoals(cp.goals, cp.goalIndex);
      if (stopped) return stopped;
      return this.#finish('COMPLETED', null);
    } catch (error) {
      const code = error instanceof BudgetError ? 'BUDGET_EXCEEDED' : 'INTERNAL';
      const message = error instanceof Error ? error.message : String(error);
      return this.#finish('FAILED', { code, message });
    }
  }

  /**
   * Answer a question about the attached file with the LOCAL model: page images one by one, the
   * text in parts (notes per part, then one combined answer). Text is redacted with the task vault
   * first; placeholders are restored only in the answer shown here.
   */
  async #analyzeFile(digest: FileDigest, code: IntentProfile): Promise<TaskResult> {
    this.#intent = code;
    this.#emit(
      'SYSTEM',
      `Reading "${digest.name}" (${digest.kind}, ${digest.pages} page${digest.pages === 1 ? '' : 's'}) on this device`,
      { file: true, kind: digest.kind, pages: digest.pages },
    );
    const analyze = this.deps.intelligence?.analyzeFile?.bind(this.deps.intelligence);
    if (!analyze) {
      return this.#finish('HUMAN_REQUIRED', {
        code: 'MODEL_UNAVAILABLE',
        message: 'Reading files needs the local model. Start Ollama, then ask again.',
      });
    }
    const question = redactText(this.#requestText, this.#vault).text;
    const intent = { ...code, query: null, siteName: null, entities: [], constraints: [] };
    const ask = async (
      part: { text?: string; image?: FileDigest['images'][number] },
      q = question,
    ) => {
      const answer = await this.#timed('model', () =>
        analyze({
          taskId: this.task.taskId,
          fileName: digest.name,
          question: q,
          intent,
          ...(part.text !== undefined ? { text: part.text } : {}),
          ...(part.image ? { image: { ...part.image, redacted: true as const, regions: 0 } } : {}),
        }),
      );
      this.#recordModel(answer.usage);
      return answer.value;
    };

    const notes: string[] = [];
    for (const [i, image] of digest.images.entries()) {
      this.#checkBudget();
      const note = await ask({ image });
      if (note) notes.push(digest.images.length > 1 ? `Page ${i + 1}: ${note}` : note);
    }
    const text = redactText(digest.text, this.#vault).text;
    const parts: string[] = [];
    for (let at = 0; at < text.length && parts.length < FILE_PARTS; at += FILE_PART_CHARS) {
      parts.push(text.slice(at, at + FILE_PART_CHARS));
    }
    for (const [i, part] of parts.entries()) {
      this.#checkBudget();
      if (parts.length > 1) {
        this.#emit('SYSTEM', `Reading part ${i + 1} of ${parts.length}`, { part: i + 1 });
      }
      const note = await ask(
        { text: part },
        parts.length > 1
          ? `${question}\n(This is part ${i + 1} of ${parts.length} of the file. Answer from this part only; say "nothing relevant" if it has nothing.)`
          : question,
      );
      if (note) notes.push(note);
    }
    let answer: string | null = notes.length === 1 ? notes[0]! : null;
    if (notes.length > 1) {
      answer = await ask(
        { text: notes.join('\n\n').slice(0, FILE_PART_CHARS) },
        `${question}\n(The file content below is notes from each part of the file. Combine them into one answer.)`,
      );
    }
    if (!answer) {
      return this.#finish('FAILED', {
        code: 'MODEL_NO_ANSWER',
        message:
          text.length === 0 && digest.images.length === 0
            ? `No readable content was found in "${digest.name}".`
            : 'The local model did not answer. Check that Ollama is running, then ask again.',
      });
    }
    const shown = answer.replace(
      /\b[A-Z]{2,24}_\d{3}\b/g,
      (t) => this.#vault.resolve(t, { consume: false }) ?? t,
    );
    this.#output = {
      kind: 'text',
      title: `About ${digest.name}`.slice(0, 200),
      text: shown.slice(0, 8000),
      source: 'model',
    };
    return this.#finish('COMPLETED', null);
  }

  /** A conversational answer: shown as text, nothing opened or clicked. */
  #reply(text: string, source: 'model' | 'extractive', code: IntentProfile): TaskResult {
    this.#intent = code;
    this.#output = { kind: 'text', title: 'Reply', text, source };
    this.#emit('SYSTEM', 'Small talk: replied in the panel, no browsing', { chat: true });
    return this.#finish('COMPLETED', null);
  }

  #finish(status: TaskStatus, error: { code: string; message: string } | null): TaskResult {
    this.#vault.purge();
    this.#timings.totalMs = this.#clock() - this.#startClock;
    const result = TaskResult.parse({
      taskId: this.task.taskId,
      text: this.task.text,
      status,
      intent: this.#intent,
      target: this.#target,
      navigation: this.#navigation,
      privacy: this.#privacy,
      models: this.#models,
      output: this.#output,
      handover:
        this.#handover ??
        (status === 'HUMAN_REQUIRED' && error
          ? handoverInfo('other', error.message, false, null)
          : null),
      steps: this.#steps,
      timings: this.#timings,
      tabId: this.#tabId,
      finalUrl: this.#finalUrl,
      error: error ? { code: error.code, message: error.message.slice(0, 500) } : null,
      startedAt: this.#startedAt,
      finishedAt: this.#now(),
    });
    if (status === 'COMPLETED') {
      this.#emit('TASK_COMPLETED', `Completed in ${Math.round(this.#timings.totalMs)} ms`, {
        totalMs: Math.round(this.#timings.totalMs),
        steps: this.#steps.length,
      });
    } else {
      this.#emit(
        'TASK_FAILED',
        error?.message ?? status,
        { status, code: error?.code ?? null },
        'warn',
      );
    }
    return result;
  }

  async #achieve(goal: Goal): Promise<StepReport> {
    const ladder = new RecoveryLadder((d) =>
      this.#emit('SYSTEM', `Recovery L${d.level} ${d.strategy}: ${d.reason}`, {
        level: d.level,
        strategy: d.strategy,
      }),
    );
    const base = { goal: goal.kind, description: describeGoal(goal) } as const;
    this.#lastHandoverKind = null;
    try {
      const outcome = await this.#dispatch(goal, ladder);
      this.#verified(outcome.verified, outcome.evidence, goal);
      return {
        ...base,
        ...outcome,
        attempts: ladder.decisions.length + 1,
        recovery: ladder.decisions,
      };
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      if (error instanceof HandoverError) this.#lastHandoverKind = error.kind;
      const reason = error instanceof Error ? error.message : String(error);
      ladder.handover(reason, `goal-${goal.kind}`);
      this.#verified(false, reason, goal);
      return {
        ...base,
        actionType: null,
        target: null,
        verified: false,
        evidence: reason.slice(0, 500),
        attempts: ladder.decisions.length,
        recovery: ladder.decisions,
      };
    }
  }

  // ── model tiers (Phase 3) ────────────────────────────────────────────────────────────────

  #recordModel(usage: ModelUsage) {
    this.#models.push(usage);
    if (usage.reason !== 'disabled') this.#timings.modelCalls += 1;
    this.#emit(
      'MODEL_CALLED',
      `${usage.tier} (${usage.modelId}): ${usage.outcome} in ${Math.round(usage.latencyMs)} ms${usage.reason ? ` — ${usage.reason}` : ''}`,
      {
        tier: usage.tier,
        modelId: usage.modelId,
        outcome: usage.outcome,
        latencyMs: Math.round(usage.latencyMs),
      },
      usage.outcome === 'answered' || usage.outcome === 'escalated' ? 'info' : 'warn',
    );
  }

  /** Ask the user instead of guessing (spec §21: … → HANDOVER / ABSTAIN). */
  #clarify(message: string, intent: IntentProfile): { finish: TaskResult } {
    this.#intent = intent;
    this.#emit('HANDOVER_REQUIRED', message, { reason: 'clarification' }, 'warn');
    return { finish: this.#finish('HUMAN_REQUIRED', { code: 'NEEDS_CLARIFICATION', message }) };
  }

  /** Read the open page once for the model tiers: facts for Laya, a sanitized page for the model. */
  async #readPageForModels(
    context: TabContext | null,
  ): Promise<{ facts: PageFacts | null; obs: Observation | null }> {
    if (!context) return { facts: null, obs: null };
    this.#tabId = context.tabId;
    try {
      const obs = await this.#observe();
      const query = currentQuery(obs);
      return {
        obs,
        facts: {
          host: context.host,
          canSearch: groundSearchInput(obs).length > 0 || groundSearchToggle(obs).length > 0,
          resultCount: rankResults(obs, query, null).length,
        },
      };
    } catch {
      return { facts: { host: context.host, canSearch: false, resultCount: 0 }, obs: null };
    } finally {
      this.#tabId = null;
    }
  }

  /**
   * Code → Laya → active model → ask the user. Code readings it is sure of pass straight through
   * (0 model calls). Personal data in the request reaches a model only as vault tokens; the page
   * only as a sanitized observation; and every answer is re-checked by `profileFromModel`.
   */
  async #escalate(
    code: IntentProfile,
    context: TabContext | null,
  ): Promise<{ profile: IntentProfile } | { finish: TaskResult }> {
    const intelligence = this.deps.intelligence;
    const ambiguous = isAmbiguous(code);
    const fallback = (why: string): { profile: IntentProfile } | { finish: TaskResult } => {
      if (ambiguous) {
        return this.#clarify(
          `Which one do you mean? ${why ? `(${why}) ` : ''}Say its position, for example "open the second result", or more of its name.`,
          code,
        );
      }
      if (why) {
        this.#emit('SYSTEM', `Continuing with the code reading: ${why}`, { reason: why });
      }
      return { profile: code };
    };
    const chat = isSmallTalk(this.#requestText);
    if (!chat && !needsModel(code)) return { profile: code };
    if (!intelligence) {
      if (chat) {
        return {
          finish: this.#reply(
            "Hi! I'm Techie Mind. Tell me what to open, search, play or do on this page. (Chat replies need the local model — start Ollama to talk with me.)",
            'extractive',
            code,
          ),
        };
      }
      return fallback('');
    }

    const { text: modelText } = redactText(this.#requestText, this.#vault);
    // What models see of the code's reading: its text fields redacted like the request, and no
    // entities/constraints (their `value` fields are never sent — the gate refuses such keys).
    const redact = (v: string | null) => (v ? redactText(v, this.#vault).text : null);
    const modelIntent: IntentProfile = {
      ...code,
      query: redact(code.query),
      siteName: redact(code.siteName),
      entities: [],
      constraints: [],
    };
    const page = await this.#readPageForModels(context);

    // Tier 1 — Laya: a fast typed decision. Small talk has no category there; go straight to tier 2.
    if (intelligence.layaEnabled && !chat) {
      const laya = await this.#timed('model', () =>
        intelligence.classify({
          taskId: this.task.taskId,
          text: modelText,
          intent: modelIntent,
          page: page.facts,
        }),
      );
      this.#recordModel(laya.usage);
      const verdict = judgeLaya(laya.value, code);
      if (verdict.kind === 'accept-code') {
        this.#proposer = 'laya';
        return {
          profile: {
            ...code,
            resolvedBy: 'laya',
            confidence: laya.value?.confidence ?? code.confidence,
          },
        };
      }
      if (verdict.kind === 'page-command') {
        return {
          profile: {
            ...code,
            intent: 'unknown',
            action: null,
            query: null,
            resolvedBy: 'laya',
            entities: [{ type: UNSUPPORTED_ENTITY, value: 'page command' }],
          },
        };
      }
    }

    // Tier 2 (local model) or tier 4 (configured gateway) — the ONE active model.
    const shown = page.obs ? sanitizeObservation(page.obs, this.#vault).observation : null;
    const answer = await this.#timed('model', () =>
      intelligence.interpret({
        taskId: this.task.taskId,
        text: modelText,
        intent: modelIntent,
        observation: shown,
      }),
    );
    this.#recordModel(answer.usage);
    const value = answer.value;
    if (chat && value?.kind !== 'chat') {
      return {
        finish: this.#reply(
          "Hi! I'm Techie Mind. Tell me what to open, search, play or do on this page.",
          'extractive',
          code,
        ),
      };
    }
    // A description of something on screen that the element list could not settle — the page may
    // show it only visually (image tiles, icon buttons): look at the page (level 4) before asking.
    const lookAtPage = async () =>
      ambiguous && context && page.obs && visionWorthTrying(page.obs)
        ? this.#visualProfile(code, context, page.obs, modelText)
        : null;
    if (!value)
      return (await lookAtPage()) ?? fallback(`${answer.usage.tier} ${answer.usage.outcome}`);
    if (value.kind === 'abstain')
      return (await lookAtPage()) ?? this.#clarify(value.question, code);
    if (value.kind === 'chat') {
      this.#proposer = answer.usage.tier === 'api' ? 'api' : 'qwen';
      return { finish: this.#reply(value.reply, 'model', code) };
    }
    const mapped = profileFromModel(value, code, modelText, shown, answer.usage.tier);
    if (!mapped.ok) {
      this.#recordModel({
        ...answer.usage,
        outcome: 'rejected',
        latencyMs: 0,
        reason: mapped.reason,
      });
      return (await lookAtPage()) ?? fallback(`model answer refused: ${mapped.reason}`);
    }
    // Tokens in a model query stand for the user's own words: restore them locally.
    let profile = mapped.profile;
    if (profile.query) {
      profile = {
        ...profile,
        query: profile.query.replace(
          /\b[A-Z]{2,24}_\d{3}\b/g,
          (t) => this.#vault.resolve(t, { consume: false }) ?? t,
        ),
      };
    }
    this.#proposer = answer.usage.tier === 'api' ? 'api' : 'qwen';
    return { profile };
  }

  /**
   * Level 4 — look at the screen. Capture the visible tab (sensitive regions painted over inside
   * the host), ask the local vision model where the target is, map its box to page coordinates and
   * ground it to one visible interactive DOM element. Returns null whenever any step cannot be
   * trusted; the caller then hands over. Never a coordinate click.
   */
  async #visualGround(target: string, obs: Observation): Promise<DOMNode | null> {
    const locate = this.deps.intelligence?.locate?.bind(this.deps.intelligence);
    const capture = this.deps.host.captureVisible?.bind(this.deps.host);
    if (!locate || !capture || !visionWorthTrying(obs)) return null;
    this.#emit(
      'SYSTEM',
      'The page structure does not identify the target — looking at the screen',
      {
        reason: 'semantic-perception-insufficient',
      },
    );
    return this.#timed('vision', async () => {
      const shot = await capture(this.#tab, {
        people: this.deps.settings.privacy.faceBlurring,
      }).catch(() => null);
      if (!shot) {
        this.#emit('SYSTEM', 'The tab could not be captured for vision', {}, 'warn');
        return null;
      }
      this.#emit(
        'PRIVACY_EVENT',
        `Screenshot redacted locally: ${shot.image.regions} sensitive region(s) painted over before vision`,
        { regions: shot.image.regions, width: shot.image.width, height: shot.image.height },
      );
      const answer = await locate({
        taskId: this.task.taskId,
        target: redactText(target, this.#vault).text,
        intent: {
          ...(this.#intent ?? resolveIntent(this.task.text).profile),
          entities: [],
          constraints: [],
        },
        image: shot.image,
      });
      this.#recordModel(answer.usage);
      if (!answer.value?.found) return null;
      const region = regionToPage(answer.value.box, shot);
      const match = groundRegion(region, obs);
      if (!match) {
        this.#emit('SYSTEM', 'Vision found a region, but no page element is there — not clicking', {
          x: Math.round(region.x),
          y: Math.round(region.y),
        });
        return null;
      }
      this.#grounded('visually located element', match.node, 0, [
        `vision box ${answer.value.confidence.toFixed(2)}`,
        `overlap ${match.overlap.toFixed(2)}`,
        match.centerInside ? 'centre inside element' : 'mostly covered',
      ]);
      return match.node;
    });
  }

  /** Turn a visually located element into an open-element plan for an ambiguous page reference. */
  async #visualProfile(
    code: IntentProfile,
    context: TabContext,
    obs: Observation,
    modelText: string,
  ): Promise<{ profile: IntentProfile } | null> {
    this.#tabId = context.tabId;
    try {
      const node = await this.#visualGround(modelText, obs);
      if (!node) return null;
      this.#proposer = 'vision';
      const label =
        (node.name ?? node.text ?? 'the item you described').slice(0, 120) ||
        'the item you described';
      return {
        profile: {
          ...code,
          intent: 'navigate',
          action: 'open_element',
          query: null,
          resolvedBy: 'vision',
          confidence: 0.6,
          entities: [
            { type: ELEMENT_ENTITY, value: node.nodeId },
            { type: ELEMENT_LABEL_ENTITY, value: label },
          ],
          targetSource: 'CURRENT_PAGE',
          navigationPolicy: 'REUSE_CURRENT_CONTEXT',
        },
      };
    } finally {
      this.#tabId = null;
    }
  }

  /** Open (or play) the element a model picked from the page it was shown. One click, verified. */
  async #openElement(goal: Extract<Goal, { kind: 'open-element' }>) {
    this.#checkBudget();
    const obs = await this.#observe();
    const node = obs.domNodes.find((n) => n.nodeId === goal.elementId);
    if (!node || !node.visible) {
      throw new HandoverError(`"${goal.label}" is no longer on the page.`, 'ambiguous');
    }
    this.#grounded('model-chosen element', node, 0, [`picked by ${this.#proposer}`]);
    const before = await this.deps.host.probe(this.#tab, null);
    if (!before) throw new HandoverError('The tab no longer shows a web page.', 'policy');
    const openedBefore = await this.#openedTabs();
    const clicked = await this.#execute(
      obs,
      node,
      { type: 'CLICK' },
      `Open ${describeNode(node)}`,
      { kind: goal.media ? 'media-playing' : 'url-changed', description: 'the chosen item opens' },
      0.7,
    );
    if (clicked.result.status !== 'executed') {
      throw new HandoverError(
        `Could not click "${goal.label}": ${clicked.result.code ?? ''} ${clicked.result.message}`,
        'verification-failed',
      );
    }
    let after = await this.#settle(before, NEW_TAB_CHECK_MS);
    if (!after || samePage(before, after)) {
      const adopted = await this.#adoptOpenedTab(openedBefore);
      after = adopted ?? (await this.#settle(before, ACTION_SETTLE_MS - NEW_TAB_CHECK_MS));
    }
    if (after && isChallengePage(after, null, null)) {
      throw new HandoverError(challengeMessage(after.url), 'policy', 'captcha');
    }
    const verdict = goal.media
      ? await this.#verifyPlayback(before, after)
      : verifyOpenResult({ before, after, media: false });
    return { actionType: 'CLICK' as const, target: describeNode(node), ...verdict };
  }

  // ── Phase 5 goals ──────────────────────────────────────────────────────────────────────────

  async #dispatch(goal: Goal, ladder: RecoveryLadder) {
    switch (goal.kind) {
      case 'use-context':
        return this.#useContext(goal);
      case 'navigate':
        return this.#navigate(goal, ladder);
      case 'search':
        return this.#search(goal, ladder);
      case 'open-element':
        return this.#openElement(goal);
      case 'open-result':
        return this.#openResult(goal, ladder);
      case 'extract':
        return this.#extract(goal);
      case 'pick-item':
        return this.#pickItem(goal);
      case 'scroll':
        return this.#scroll(goal);
      case 'history':
        return this.#history(goal);
      case 'add-to-cart':
        return this.#addToCart();
      case 'checkout':
        return this.#checkout(goal);
      case 'fill-form':
        return this.#fillForm();
      case 'submit-form':
        return this.#submitForm();
      case 'summarize':
        return this.#summarize();
      case 'upload':
        return this.#upload();
      case 'skill':
        return this.#skill(goal);
    }
  }

  /**
   * "Upload it": put the file the user attached into the page's file field, through the firewall,
   * and verify the field holds it. Nothing is submitted — sending the form stays the user's step.
   */
  async #upload() {
    const file = this.deps.attachment;
    if (!file) {
      throw new HandoverError(
        'Attach the file first with the paperclip in the side panel, then ask again.',
        'policy',
      );
    }
    const obs = await this.#observe();
    const fields = obs.domNodes.filter(
      (n) => n.tag === 'input' && n.inputType === 'file' && n.attributes['disabled'] === undefined,
    );
    if (fields.length === 0) {
      throw new HandoverError('No file upload field was found on this page.', 'ambiguous');
    }
    // Prefer a visible field, then the first one in the page.
    const field = fields.find((n) => n.visible) ?? fields[0]!;
    this.#grounded('file upload field', field, 5, [
      fields.length > 1 ? `first of ${fields.length} file fields` : 'the file field',
    ]);
    const { result } = await this.#execute(
      obs,
      field,
      { type: 'UPLOAD', fileRef: file.fileRef },
      `Upload "${file.name}"`,
      { kind: 'field-value', description: `the field holds ${file.name}` },
      0.8,
    );
    const ok = result.status === 'executed' && result.valueAfter === file.name;
    return {
      actionType: 'UPLOAD' as const,
      target: describeNode(field),
      verified: ok,
      evidence: ok
        ? `"${file.name}" (${Math.round(file.size / 1024)} KB) is in the file field — not submitted; send the form yourself`
        : `the page did not take the file: ${result.message}`,
    };
  }

  /** Items on the page, read in the page (generic extraction). */
  async #readItems(): Promise<ExtractedItem[]> {
    const extract = this.deps.host.extractItems?.bind(this.deps.host);
    if (!extract) throw new HandoverError('Reading items is not available on this page.', 'policy');
    const reply = await this.#timed('grounding', () => extract(this.#tab));
    return cleanItems(reply?.items ?? []);
  }

  async #itemsOutput(items: ExtractedItem[], total: number, title: string) {
    const obs = await this.#observe();
    const probe = await this.deps.host.probe(this.#tab, null);
    const host = probe ? new URL(probe.url).hostname : null;
    const byId = new Map(obs.domNodes.map((n) => [n.nodeId, n]));
    this.#output = {
      kind: 'items',
      title: title.slice(0, 200),
      total,
      items: items.slice(0, 60).map((i) => {
        const href = byId.get(i.elementId)?.attributes['href'] ?? null;
        let url: string | null = null;
        try {
          const u = href && probe ? new URL(href, probe.url) : null;
          url = u ? `${u.origin}${u.pathname}`.slice(0, 2048) : null;
        } catch {
          url = null;
        }
        return {
          title: i.title,
          price: i.price,
          currency: i.currency,
          rating: i.rating,
          url,
          source: host,
        };
      }),
    };
  }

  /** "laptops under ₹50,000": read the results, keep those within the bounds, report them. */
  async #extract(goal: Extract<Goal, { kind: 'extract' }>) {
    let items = await this.#readItems();
    if (items.length === 0) {
      await this.#settle(null, ACTION_SETTLE_MS);
      items = await this.#readItems();
    }
    const within = items.filter(
      (i) =>
        i.price !== null &&
        (goal.maxPrice === null || i.price <= goal.maxPrice) &&
        (goal.minPrice === null || i.price >= goal.minPrice),
    );
    const bound =
      goal.maxPrice !== null
        ? `up to ${goal.maxPrice.toLocaleString('en-IN')}`
        : `from ${goal.minPrice?.toLocaleString('en-IN')}`;
    await this.#itemsOutput(
      within,
      items.length,
      `${within.length} of ${items.length} results ${bound}`,
    );
    const priced = items.filter((i) => i.price !== null).length;
    return {
      actionType: 'EXTRACT' as const,
      target: null,
      verified: items.length > 0,
      evidence:
        items.length === 0
          ? 'no result items could be read on this page'
          : `read ${items.length} results (${priced} with a price); ${within.length} ${bound}`,
    };
  }

  /** "open the cheapest one": pick by value from the items on the page, then open it once. */
  async #pickItem(goal: Extract<Goal, { kind: 'pick-item' }>) {
    // Only items about what the page was searched for ("cheapest iPhone 15" ≠ the cheapest case).
    const query = currentQuery(await this.#observe());
    const all = await this.#readItems();
    const relevant = query ? all.filter((i) => matchesAllTerms(i.title, query)) : all;
    const items = relevant.length > 0 ? relevant : all;
    const candidates =
      goal.by === 'top-rated'
        ? items.filter((i) => i.rating !== null)
        : items.filter((i) => i.price !== null);
    if (candidates.length === 0) {
      throw new HandoverError(
        goal.by === 'top-rated'
          ? 'No ratings are shown on this page, so the top-rated item cannot be chosen.'
          : 'No prices are shown on this page, so the cheapest item cannot be chosen.',
        'ambiguous',
      );
    }
    const best = candidates.reduce((a, b) => {
      if (goal.by === 'top-rated') return (b.rating ?? 0) > (a.rating ?? 0) ? b : a;
      if (goal.by === 'cheapest') return (b.price ?? Infinity) < (a.price ?? Infinity) ? b : a;
      return (b.price ?? -1) > (a.price ?? -1) ? b : a;
    });
    this.#emit(
      'TARGET_GROUNDED',
      `${goal.by} of ${candidates.length} items: "${best.title.slice(0, 80)}"${best.price !== null ? ` · ${best.currency ?? ''} ${best.price}` : ''}`,
      { nodeId: best.elementId, by: goal.by, candidates: candidates.length },
    );
    return this.#openElement({
      kind: 'open-element',
      elementId: best.elementId,
      label: best.title.slice(0, 120),
      media: false,
    });
  }

  async #viewportY(): Promise<number> {
    return (await this.#observe()).viewport.scrollY;
  }

  async #scroll(goal: Extract<Goal, { kind: 'scroll' }>) {
    const obs = await this.#observe();
    const before = obs.viewport.scrollY;
    const { result } = await this.#execute(
      obs,
      null,
      { type: 'SCROLL', direction: goal.direction, amount: null },
      `Scroll ${goal.direction}`,
      { kind: 'dom-mutation', description: 'the page moves' },
      0.9,
    );
    if (result.status !== 'executed') {
      return {
        actionType: 'SCROLL' as const,
        target: null,
        verified: false,
        evidence: result.message,
      };
    }
    await this.#timed('wait', () => new Promise((r) => setTimeout(r, 250)));
    const after = await this.#viewportY();
    const moved = Math.round(after - before);
    return {
      actionType: 'SCROLL' as const,
      target: null,
      verified: moved !== 0,
      evidence:
        moved !== 0
          ? `scrolled ${goal.direction} ${Math.abs(moved)} px`
          : `already at the ${goal.direction === 'down' ? 'bottom' : 'top'} of the page`,
    };
  }

  async #history(goal: Extract<Goal, { kind: 'history' }>) {
    const before = await this.deps.host.probe(this.#tab, null);
    if (!before) throw new HandoverError('The tab no longer shows a web page.', 'policy');
    this.#emit('NAVIGATION_STARTED', goal.direction === 'back' ? 'Going back' : 'Going forward', {
      reason: `history-${goal.direction}`,
    });
    let failed = false;
    try {
      if (goal.direction === 'back') await this.deps.host.goBack(this.#tab);
      else if (this.deps.host.goForward) await this.deps.host.goForward(this.#tab);
      else throw new Error('going forward is not available here');
    } catch {
      failed = true;
    }
    let after = failed ? before : await this.#settle(before, ACTION_SETTLE_MS);
    let moved = !!after && !samePage(before, after);
    if (!moved && goal.direction === 'back') {
      // Chrome's back list skips entries created without a user gesture — which is every page the
      // agent opened. Return to the previous page the agent saw in this tab, on the same site,
      // through the firewall like any navigation.
      const previous = await this.deps.host.previousUrl?.(this.#tab).catch(() => null);
      if (previous && new URL(previous).origin === new URL(before.url).origin) {
        await this.#navigateGuarded(this.#tab, previous, 'returning to the previous page');
        after = await this.#settle(before, ACTION_SETTLE_MS);
        moved = !!after && !samePage(before, after);
      }
    }
    return {
      actionType: null,
      target: after ? new URL(after.url).hostname : null,
      verified: moved,
      evidence: moved
        ? `now on ${after!.url.split('?')[0]}`
        : `there is no page to go ${goal.direction} to`,
    };
  }

  /** Cart evidence on a page: a cart-like address, an "added to cart" message, or a cart count. */
  #cartState(
    obs: Observation,
    url: string,
  ): { count: number | null; added: boolean; onCart: boolean } {
    let count: number | null = null;
    let added = false;
    for (const n of obs.domNodes) {
      const text = `${n.name ?? ''} ${n.text ?? ''}`;
      if (
        /added to (?:your )?(?:cart|bag|basket)|go to (?:cart|bag|basket)|view (?:cart|bag|basket)|item added/i.test(
          text,
        )
      ) {
        added = true;
      }
      if (/\b(?:cart|bag|basket)\b/i.test(text)) {
        const m = /(\d{1,3})/.exec(text);
        if (m) count = Math.max(count ?? 0, Number(m[1]));
      }
    }
    const onCart = /\/(?:cart|bag|basket|viewcart)(?:[/?#]|$)/i.test(new URL(url).pathname);
    return { count, added, onCart };
  }

  async #addToCart() {
    const obs = await this.#observe();
    const button = obs.domNodes.find(
      (n) =>
        n.visible &&
        n.interactive &&
        /^(?:add to (?:cart|bag|basket)|add item to (?:cart|bag|basket))\b/i.test(
          (n.name ?? n.text ?? '').trim(),
        ),
    );
    if (!button) {
      throw new HandoverError(
        'No "Add to cart" button is visible on this page. Open a product first.',
        'ambiguous',
      );
    }
    const before = this.#cartState(obs, obs.url);
    const probeBefore = await this.deps.host.probe(this.#tab, null);
    this.#grounded('add-to-cart control', button, 6, ['button named Add to cart']);
    const { result } = await this.#execute(
      obs,
      button,
      { type: 'CLICK' },
      'Add the item to the cart',
      { kind: 'cart-changed', description: 'the cart changes' },
      0.85,
    );
    if (result.status !== 'executed') {
      return {
        actionType: 'CLICK' as const,
        target: describeNode(button),
        verified: false,
        evidence: result.message,
      };
    }
    const settled = await this.#settle(probeBefore, ACTION_SETTLE_MS);
    const after = await this.#observe();
    const state = this.#cartState(after, settled?.url ?? after.url);
    const grew = state.count !== null && (before.count === null || state.count > before.count);
    const verified = state.added || state.onCart || grew;
    return {
      actionType: 'CLICK' as const,
      target: describeNode(button),
      verified,
      evidence: verified
        ? `added — ${state.added ? 'the page confirms it' : state.onCart ? 'the cart page opened' : `cart count ${before.count ?? 0} → ${state.count}`}`
        : 'clicked, but the page shows no sign the item was added',
    };
  }

  /**
   * "go to cart" opens the cart. "checkout" uses the page's checkout control when there is one —
   * the firewall classifies it as payment and hands over — and otherwise opens the cart first.
   */
  async #checkout(goal: Extract<Goal, { kind: 'checkout' }>) {
    const obs = await this.#observe();
    const label = (n: DOMNode) => (n.name ?? n.text ?? '').trim();
    const cartLink = obs.domNodes.find(
      (n) =>
        n.visible &&
        n.interactive &&
        /^(?:go to |view |my |your )?(?:cart|bag|basket)(?:\s*\(?\d+\)?)?$/i.test(label(n)),
    );
    const checkoutControl = obs.domNodes.find(
      (n) => n.visible && n.interactive && CHECKOUT_LABEL.test(label(n)),
    );
    // The financial boundary: a checkout control starts the payment flow — the user presses it.
    // On a product page without one, "checkout" opens the cart first; "Buy now" with no cart to
    // go to is a payment step too.
    const buyNow = obs.domNodes.find(
      (n) => n.visible && n.interactive && BUY_NOW_LABEL.test(label(n)),
    );
    const payment =
      goal.target === 'checkout' ? (checkoutControl ?? (cartLink ? null : buyNow)) : null;
    if (payment) {
      throw new HandoverError(
        `"${label(payment).slice(0, 80)}" starts the payment — the agent stops here. Press it yourself if you want to buy.`,
        'policy',
        'payment',
      );
    }
    const control = cartLink;
    if (!control)
      throw new HandoverError('No cart or checkout control is visible on this page.', 'ambiguous');
    this.#grounded('cart / checkout control', control, 5, ['named cart or checkout']);
    const before = await this.deps.host.probe(this.#tab, null);
    const { result } = await this.#execute(
      obs,
      control,
      { type: 'CLICK' },
      'Open the cart',
      { kind: 'url-changed', description: 'the cart opens' },
      0.8,
    );
    if (result.status !== 'executed') {
      return {
        actionType: 'CLICK' as const,
        target: describeNode(control),
        verified: false,
        evidence: result.message,
      };
    }
    const after = await this.#settle(before, ACTION_SETTLE_MS);
    const moved = !!after && !!before && !samePage(before, after);
    return {
      actionType: 'CLICK' as const,
      target: describeNode(control),
      verified: moved,
      evidence: moved
        ? `cart open (${after!.url.split('?')[0]}) — the agent stops here; payment is always yours`
        : 'the cart did not open',
    };
  }

  /** "Fill this form with my profile": map fields by meaning, type through vault tokens, verify. */
  /**
   * "submit the form": only on the user's word. The firewall always asks "Confirm this action"
   * first (confirmAt MEDIUM for this click), and still refuses payment, sign-in and OTP controls.
   */
  async #submitForm() {
    const obs = await this.#observe();
    const label = (n: DOMNode) => (n.name ?? n.text ?? '').trim();
    const visible = obs.domNodes.filter((n) => n.visible && n.interactive);
    const button =
      visible.find((n) => n.attributes['type'] === 'submit' || n.inputType === 'submit') ??
      visible.find((n) =>
        /^(?:submit|send|save|continue|next|register|sign up|apply|place request|confirm)\b/i.test(
          label(n),
        ),
      );
    if (!button) {
      throw new HandoverError(
        'No submit button is visible on this page. Scroll to it, or press it yourself.',
        'ambiguous',
      );
    }
    const probeBefore = await this.deps.host.probe(this.#tab, null);
    this.#grounded('submit control', button, 6, [`button "${label(button).slice(0, 60)}"`]);
    const { result } = await this.#execute(
      obs,
      button,
      { type: 'CLICK' },
      'Submit the form (you asked for it)',
      { kind: 'url-changed', description: 'the form is sent' },
      0.8,
      { confirmAt: 'MEDIUM' },
    );
    if (result.status !== 'executed') {
      return {
        actionType: 'CLICK' as const,
        target: describeNode(button),
        verified: false,
        evidence: result.message,
      };
    }
    const settled = await this.#settle(probeBefore, ACTION_SETTLE_MS);
    const moved = Boolean(settled && probeBefore && settled.url !== probeBefore.url);
    return {
      actionType: 'CLICK' as const,
      target: describeNode(button),
      verified: true,
      evidence: moved
        ? `submitted — the page moved to ${safePath(settled!.url)}`
        : 'submit pressed — check the page for its confirmation',
    };
  }

  async #fillForm() {
    const load = this.deps.host.loadProfile?.bind(this.deps.host);
    const profile = load ? await load().catch(() => null) : null;
    if (!profile) {
      throw new HandoverError(
        'No saved profile yet. Add your details in Settings → Profile, then ask again.',
        'policy',
      );
    }
    const obs = await this.#observe();
    const fields = formFields(obs.domNodes);
    if (fields.length === 0)
      throw new HandoverError('No form fields are visible on this page.', 'ambiguous');
    const all = fields.map((node) => planField(node, profile));
    // "fill the phone number" fills only the phone number; "fill this form" fills everything.
    const wanted = requestedFields(this.#requestText || this.task.text);
    const plans = wanted ? targetPlans(fields, all, wanted, profile) : all;
    if (wanted && plans.length === 0) {
      throw new HandoverError(
        `No field for your ${[...wanted].map((f) => f.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' or ')} is visible on this page.`,
        'ambiguous',
      );
    }
    const filled: string[] = [];
    const skipped: string[] = [];
    let current = obs;
    for (const plan of plans) {
      if ('skip' in plan) {
        skipped.push(
          plan.skip === 'secret'
            ? `"${plan.label}" (never filled by the agent)`
            : plan.skip === 'unknown'
              ? `"${plan.label}" (not in your profile)`
              : `"${plan.label}" (empty in your profile)`,
        );
        continue;
      }
      // Re-observe after each field: pages re-render as they validate.
      current = await this.#observe();
      const node = current.domNodes.find((n) => n.nodeId === plan.node.nodeId);
      if (!node || !node.visible) {
        skipped.push(`"${plan.field}" (field disappeared)`);
        continue;
      }
      this.#grounded(`form field (${plan.field})`, node, 5, [`matched ${plan.field} by meaning`]);
      const token = this.#vault.tokenize(plan.kind, plan.value);
      const { result } = await this.#execute(
        current,
        node,
        node.tag === 'select'
          ? { type: 'SELECT', value: plan.value }
          : { type: 'TYPE', input: { vaultToken: token }, submit: false },
        `Fill ${plan.field} from your profile`,
        { kind: 'field-value', description: `${plan.field} holds your saved value` },
        0.85,
      );
      const ok =
        result.status === 'executed' &&
        (result.valueAfter ?? '').trim().toLowerCase() === plan.value.trim().toLowerCase();
      if (ok) filled.push(plan.field);
      else
        skipped.push(
          `"${plan.field}" (${result.status === 'executed' ? 'value did not stick' : result.message})`,
        );
    }
    this.#output = {
      kind: 'list',
      title: `Filled ${filled.length} field(s) from your profile — nothing was submitted`,
      entries: [
        ...filled.map((f) => `✓ ${f}`),
        ...skipped.map((s) => `– skipped ${s}`),
        'Review the form and submit it yourself.',
      ],
    };
    return {
      actionType: 'TYPE' as const,
      target: `${fields.length} form field(s)`,
      verified: filled.length > 0,
      evidence:
        filled.length > 0
          ? `filled and verified ${filled.length} field(s); ${skipped.length} skipped; not submitted`
          : `no field could be filled (${skipped.length} skipped)`,
    };
  }

  /** Summary from locally extracted text, redacted with the task vault before any model sees it. */
  /** The user's instructions for a model-written skill, when set (Settings → Skills). */
  #instructions(id: SkillId): { instructions?: string } {
    const text = this.deps.skillInstructions?.[id]?.trim();
    return text ? { instructions: text } : {};
  }

  async #summarize() {
    const extract = this.deps.host.extractText?.bind(this.deps.host);
    if (!extract) throw new HandoverError('Reading this page is not available here.', 'policy');
    const text = await this.#timed('grounding', () => extract(this.#tab));
    if (!text || (text.paragraphs.length === 0 && text.headings.length === 0)) {
      throw new HandoverError('This page has no readable text to summarize.', 'ambiguous');
    }
    const redact = (t: string) => redactText(t, this.#vault).text;
    const headings = text.headings.map(redact);
    const paragraphs = text.paragraphs.map(redact);
    const probe = await this.deps.host.probe(this.#tab, null);
    const origin = probe ? new URL(probe.url).origin : 'https://page.invalid';
    const title = redact(text.title);
    let summary: string | null = null;
    let source: 'model' | 'extractive' = 'extractive';
    const summarize = this.deps.intelligence?.summarize?.bind(this.deps.intelligence);
    if (summarize && probe) {
      const page = SanitizedObservation.parse({
        observationId: this.#newId('text'),
        version: 0,
        origin,
        path: safePath(probe.url),
        title: title.slice(0, 512),
        createdAt: this.#now(),
        nodes: [
          ...headings.slice(0, 40).map((h, i) => ({
            nodeId: `h-${i}`,
            role: 'heading',
            name: null,
            text: h.slice(0, 2000),
            interactive: false,
            editable: false,
            bbox: null,
          })),
          ...paragraphs.slice(0, 120).map((p, i) => ({
            nodeId: `p-${i}`,
            role: 'paragraph',
            name: null,
            text: p.slice(0, 2000),
            interactive: false,
            editable: false,
            bbox: null,
          })),
        ],
        findings: [],
        redactionCount: 0,
        sanitized: true,
      });
      const answer = await this.#timed('model', () =>
        summarize({
          taskId: this.task.taskId,
          intent: {
            ...(this.#intent ?? resolveIntent(this.task.text).profile),
            entities: [],
            constraints: [],
          },
          page,
          ...this.#instructions('summarize-page'),
        }),
      );
      this.#recordModel(answer.usage);
      if (answer.value) {
        summary = answer.value;
        source = 'model';
      }
    }
    if (!summary) {
      // Extractive: the page's own first sentences, under its headings. No model needed.
      const firstSentence = (p: string) =>
        /^.{20,240}?[.!?](?=\s|$)/.exec(p)?.[0] ?? p.slice(0, 200);
      const bullets = [
        ...(headings[0] ? [headings[0]] : []),
        ...paragraphs.slice(0, 5).map(firstSentence),
      ];
      summary = bullets
        .slice(0, 5)
        .map((b) => `• ${b}`)
        .join('\n');
    }
    this.#output = {
      kind: 'text',
      title: `Summary: ${title}`.slice(0, 200),
      text: summary.slice(0, 8000),
      source,
    };
    return {
      actionType: 'EXTRACT' as const,
      target: null,
      verified: summary.length > 0,
      evidence: `summarized ${paragraphs.length} paragraph(s) ${source === 'model' ? 'with the local model' : 'locally (no model)'}${text.truncated ? ' (long page: first part)' : ''}`,
    };
  }

  // ── Phase 6 skills ─────────────────────────────────────────────────────────────────────────

  /** Skills that work without an open page (they navigate themselves or use browser data). */
  static #PAGELESS = new Set<SkillId>(['organize-tabs', 'deep-research', 'compare-prices']);

  async #runSkill(profile: IntentProfile, context: TabContext | null): Promise<TaskResult> {
    const id = profile.entities.find((e) => e.type === SKILL_ENTITY)?.value as SkillId;
    const arg = profile.entities.find((e) => e.type === SKILL_ARG_ENTITY)?.value ?? '';
    const listOnly =
      (id === 'manage-bookmarks' && arg.startsWith('search')) ||
      (id === 'read-later' && arg === 'list');
    const needsPage = !TaskRun.#PAGELESS.has(id) && !listOnly;
    if (needsPage && !context) {
      return this.#finish('FAILED', {
        code: 'NO_RESULTS_CONTEXT',
        message: 'There is no open web page for this skill. Open the page first.',
      });
    }
    if (context) {
      this.#tabId = context.tabId;
      this.#navigation = this.#record(
        { targetSource: 'CURRENT_PAGE', navigationPolicy: 'REUSE_CURRENT_CONTEXT', reuse: true },
        context,
        null,
        `skill ${id} on the open page`,
      );
    } else if (TaskRun.#PAGELESS.has(id) && id !== 'organize-tabs') {
      this.#tabId = await this.deps.host.prepareTab();
    }
    this.#emit('TARGET_ROUTED', `Skill: ${id}${context ? ` on ${context.host}` : ''}`, {
      skill: id,
    });
    // Same step loop as any plan: a human check inside a skill can be continued after the user acts.
    const stopped = await this.#runGoals([{ kind: 'skill', id, arg }], 0);
    return stopped ?? this.#finish('COMPLETED', null);
  }

  #data(): BrowserData {
    const data = this.deps.host.browserData;
    if (!data)
      throw new HandoverError(
        'This skill needs browser access that is not available here.',
        'policy',
      );
    return data;
  }

  async #page(): Promise<{ url: string; clean: string; title: string; host: string }> {
    const probe = await this.deps.host.probe(this.#tab, null);
    if (!probe) throw new HandoverError('The tab no longer shows a web page.', 'policy');
    const u = new URL(probe.url);
    return {
      url: probe.url,
      clean: `${u.origin}${u.pathname}`,
      title: probe.title,
      host: u.hostname,
    };
  }

  async #skill(goal: Extract<Goal, { kind: 'skill' }>) {
    switch (goal.id) {
      case 'summarize-page':
        return this.#summarize();
      case 'fill-form':
        return this.#fillForm();
      case 'extract-data':
        return this.#skillExtract(goal.arg);
      case 'compare-prices':
        return this.#skillCompare(goal.arg);
      case 'find-alternatives':
        return this.#skillAlternatives(goal.arg);
      case 'deep-research':
        return this.#skillResearch(goal.arg);
      case 'manage-bookmarks':
        return this.#skillBookmarks(goal.arg);
      case 'monitor-page':
        return this.#skillMonitor(goal.arg);
      case 'organize-tabs':
        return this.#skillTabs(goal.arg);
      case 'read-later':
        return this.#skillReadLater(goal.arg);
      case 'save-page':
        return this.#skillSavePage();
      case 'screenshot-walkthrough':
        return this.#skillWalkthrough();
    }
  }

  #done(verified: boolean, evidence: string, target: string | null = null) {
    return { actionType: null, target, verified, evidence: evidence.slice(0, 500) };
  }

  /** extract-data: items (or table rows) from the open page; CSV/JSON export on request. */
  async #skillExtract(arg: string) {
    const page = await this.#page();
    // "export the table …": a page's data table beats its links (live Wikipedia exported link
    // titles). Items are used when no table was asked for, or the page has none.
    const wantsTable = /\btables?\b/i.test(this.#requestText);
    // "The table" is the page's main data table — the one with the most rows (a small summary box
    // comes first on many pages).
    const table = wantsTable
      ? largestTable((await this.deps.host.extractText?.(this.#tab).catch(() => null))?.tables)
      : undefined;
    const items = table && table.rows.length > 0 ? [] : await this.#readItems();
    let rows: string[][] = [];
    if (table && table.rows.length > 0) {
      rows = [table.headers, ...table.rows];
      this.#output = {
        kind: 'list',
        title: `Table with ${table.rows.length} row(s) from ${page.host}`,
        entries: rows.slice(0, 100).map((r) => r.join(' | ')),
      };
    } else if (items.length > 0) {
      await this.#itemsOutput(items, items.length, `${items.length} item(s) from ${page.host}`);
      rows = [
        ['title', 'price', 'currency', 'rating'],
        ...items.map((i) => [
          i.title,
          String(i.price ?? ''),
          i.currency ?? '',
          String(i.rating ?? ''),
        ]),
      ];
    } else {
      const text = await this.deps.host.extractText?.(this.#tab).catch(() => null);
      const table = text?.tables?.[0];
      if (!table || table.rows.length === 0) {
        throw new HandoverError('No items or tables were found on this page.', 'ambiguous');
      }
      rows = [table.headers, ...table.rows];
      this.#output = {
        kind: 'list',
        title: `Table with ${table.rows.length} row(s) from ${page.host}`,
        entries: rows.slice(0, 100).map((r) => r.join(' | ')),
      };
    }
    const format = /json/i.test(arg) ? 'json' : /csv/i.test(arg) ? 'csv' : null;
    let exported = '';
    if (format) {
      const [head = [], ...body] = rows;
      const content =
        format === 'csv'
          ? rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
          : JSON.stringify(
              body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))),
              null,
              2,
            );
      const ok = await this.#data().download({
        name: `${this.deps.settings.export.folder}/${page.host}-data.${format}`,
        mime: format === 'csv' ? 'text/csv' : 'application/json',
        content,
      });
      exported = ok ? ` · exported as ${format.toUpperCase()}` : ' · export failed';
    }
    return this.#done(
      true,
      `read ${rows.length - 1} row(s) from ${page.host}${exported}`,
      page.host,
    );
  }

  /** The item on a results page that best matches the words of a product name, with a price. */
  /** The task's tab shows a human-verification / challenge page. */
  async #onChallenge(): Promise<boolean> {
    const probe = await this.deps.host.probe(this.#tab, null).catch(() => null);
    return !!probe && isChallengePage(probe, null);
  }

  #bestMatch(items: ExtractedItem[], product: string): ExtractedItem | null {
    const words = [...new Set(termsOf(product))];
    // Short product names must match fully; numbers ("15") always must (an iPhone 17e is not one).
    const need = words.length <= 3 ? words.length : Math.ceil(words.length * 0.6);
    const numbers = words.filter((w) => /\d/.test(w));
    const scored = items
      .filter((i) => i.price !== null)
      .map((i) => {
        const title = new Set(termsOf(i.title));
        return {
          i,
          numbersOk: numbers.every((n) => title.has(n)),
          score: words.filter((w) => title.has(w)).length,
        };
      })
      .filter((x) => x.numbersOk && x.score >= Math.max(1, need));
    if (scored.length === 0) return null;
    const top = Math.max(...scored.map((x) => x.score));
    return scored.filter((x) => x.score === top).sort((a, b) => a.i.price! - b.i.price!)[0]!.i;
  }

  /** Open a site's home, search it: the same generic goals as any task, recorded as steps. */
  async #visitAndSearch(domain: string, query: string): Promise<boolean> {
    const site = siteForDomain(domain);
    const url = site?.homeUrl ?? `https://${domain}/`;
    this.#allowedHosts.add(domain);
    this.#allowedHosts.add(new URL(url).hostname);
    const nav = await this.#achieve({ kind: 'navigate', url, domain });
    this.#steps.push(nav);
    if (!nav.verified) return false;
    const search = await this.#achieve({ kind: 'search', query });
    this.#steps.push(search);
    return search.verified;
  }

  #domainsIn(text: string): string[] {
    const out: string[] = [];
    for (const part of text.split(/\s*(?:,|&|\band\b|\bvs\.?\b|\bor\b)\s*/u)) {
      const name = part.trim();
      if (!name) continue;
      const routed = resolveIntent(`open ${name}`).profile;
      if (routed.targetDomain && !out.includes(routed.targetDomain)) out.push(routed.targetDomain);
    }
    return out;
  }

  /** compare-prices: the same product on ≥2 named stores; prices only as read from each store. */
  async #skillCompare(arg: string) {
    const [productPart = '', sitesPart = ''] = arg.split('|').map((x) => x.trim());
    const product = productPart.replace(/\bprices?\b/gu, '').trim();
    const domains = this.#domainsIn(sitesPart);
    if (!product || domains.length < 2) {
      throw new HandoverError(
        'Name the product and at least two stores, e.g. "compare iPhone 15 prices on Amazon and Flipkart".',
        'ambiguous',
      );
    }
    const found: NonNullable<Extract<TaskOutput, { kind: 'items' }>['items']> = [];
    const missing: string[] = [];
    for (const domain of domains) {
      const ok = await this.#visitAndSearch(domain, product);
      const match = ok ? this.#bestMatch(await this.#readItems(), product) : null;
      if (!match) {
        missing.push(domain);
        continue;
      }
      found.push({
        title: match.title,
        price: match.price,
        currency: match.currency,
        rating: match.rating,
        url: null,
        source: domain,
      });
    }
    found.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const best = found[0];
    this.#output = {
      kind: 'items',
      title: best
        ? `Cheapest "${product}": ${best.currency === 'INR' ? '₹' : ''}${best.price?.toLocaleString('en-IN')} on ${best.source}${missing.length ? ` · no matching price on ${missing.join(', ')}` : ''}`
        : `No matching priced item for "${product}" on ${domains.join(', ')}`,
      items: found,
      total: domains.length,
    };
    return this.#done(
      found.length >= 1,
      `compared ${domains.length} store(s): ${found.length} price(s) found${missing.length ? `, none on ${missing.join(', ')}` : ''}`,
    );
  }

  /** find-alternatives: search the item on the open site, drop the item itself, keep what fits. */
  async #skillAlternatives(arg: string) {
    const { constraints, rest } = constraintsOf(arg);
    const item = rest.replace(/\s+/g, ' ').trim();
    if (!item) throw new HandoverError('Say which item you want alternatives to.', 'ambiguous');
    const search = await this.#achieve({ kind: 'search', query: item });
    this.#steps.push(search);
    if (!search.verified) return this.#done(false, `could not search for "${item}"`);
    const max = constraints.find(
      (c) => c.field === 'price' && (c.op === '<' || c.op === '<='),
    )?.value;
    const items = await this.#readItems();
    const self = item.toLowerCase();
    const options = items
      .filter((i) => !i.title.toLowerCase().includes(self))
      .filter((i) => typeof max !== 'number' || (i.price !== null && i.price <= max))
      .sort(
        (a, b) =>
          (b.rating ?? 0) - (a.rating ?? 0) || (a.price ?? Infinity) - (b.price ?? Infinity),
      )
      .slice(0, 5);
    await this.#itemsOutput(
      options,
      items.length,
      `${options.length} alternative(s) to "${item}"${typeof max === 'number' ? ` up to ₹${max.toLocaleString('en-IN')}` : ''}`,
    );
    return this.#done(
      options.length > 0,
      options.length
        ? `found ${options.length} alternative(s)`
        : 'no alternative within the constraints',
    );
  }

  /** deep-research: search, open several sources in turn, extract evidence, synthesize with citations. */
  async #skillResearch(arg: string) {
    const m = /^(.*?)\s+on\s+(\S+\.\S+)$/u.exec(arg);
    const topic = (m ? m[1]! : arg).trim();
    const domain = m ? m[2]! : siteById(DEFAULT_SEARCH_SITE)?.domain;
    if (!topic || !domain) throw new HandoverError('Say what to research.', 'ambiguous');
    if (!(await this.#visitAndSearch(domain, topic))) {
      const challenged = await this.#onChallenge();
      // A web search that asks for a human check (seen live: Google's /sorry page) is retried once
      // on another search engine — only when the user named no site.
      const fallback = siteById(FALLBACK_SEARCH_SITE)?.domain;
      const retried =
        challenged && !m && fallback ? await this.#visitAndSearch(fallback, topic) : false;
      if (!retried) {
        if (challenged || (await this.#onChallenge())) {
          throw new HandoverError(
            `${domain} is asking for a human check. Complete it in the tab, then ask again.`,
            'policy',
            'captcha',
          );
        }
        return this.#done(false, `could not search ${domain} for "${topic}"`);
      }
    }
    const results = (await this.#readItems()).slice(
      0,
      Math.min(3, this.deps.settings.research.maxSitesPerQuery),
    );
    const sources: Array<{ n: number; where: string; text: string[] }> = [];
    for (const [index, result] of results.entries()) {
      const open = await this.#achieve({
        kind: 'open-element',
        elementId: result.elementId,
        label: result.title.slice(0, 120),
        media: false,
      });
      this.#steps.push(open);
      if (open.verified) {
        const text = await this.deps.host.extractText?.(this.#tab).catch(() => null);
        const page = await this.#page().catch(() => null);
        const paras = (text?.paragraphs ?? [])
          .slice(0, 3)
          .map((p) => redactText(p, this.#vault).text);
        if (page && paras.length)
          sources.push({
            n: sources.length + 1,
            where: safePath(page.clean) === '/' ? page.host : `${page.host}${safePath(page.clean)}`,
            text: paras,
          });
      }
      if (index < results.length - 1)
        this.#steps.push(await this.#achieve({ kind: 'history', direction: 'back' }));
    }
    if (sources.length === 0) return this.#done(false, 'no source could be read');
    let synthesis: string | null = null;
    let origin: 'model' | 'extractive' = 'extractive';
    const summarize = this.deps.intelligence?.summarize?.bind(this.deps.intelligence);
    const probe = await this.deps.host.probe(this.#tab, null);
    if (summarize && probe) {
      const page = SanitizedObservation.parse({
        observationId: this.#newId('research'),
        version: 0,
        origin: new URL(probe.url).origin,
        path: '/',
        title: `Research: ${redactText(topic, this.#vault).text}`.slice(0, 512),
        createdAt: this.#now(),
        nodes: sources.flatMap((s) =>
          s.text.map((t, i) => ({
            nodeId: `s${s.n}-${i}`,
            role: 'paragraph',
            name: null,
            text: `[${s.n}] ${t}`.slice(0, 2000),
            interactive: false,
            editable: false,
            bbox: null,
          })),
        ),
        findings: [],
        redactionCount: 0,
        sanitized: true,
      });
      const answer = await this.#timed('model', () =>
        summarize({
          taskId: this.task.taskId,
          intent: {
            ...(this.#intent ?? resolveIntent(this.task.text).profile),
            entities: [],
            constraints: [],
          },
          page,
          ...this.#instructions('deep-research'),
        }),
      );
      this.#recordModel(answer.usage);
      if (answer.value) {
        synthesis = answer.value;
        origin = 'model';
      }
    }
    if (!synthesis) {
      const first = (p: string) => /^.{20,240}?[.!?](?=\s|$)/.exec(p)?.[0] ?? p.slice(0, 200);
      synthesis = sources.map((s) => `• ${first(s.text[0]!)} [${s.n}]`).join('\n');
    }
    const cites = sources.map((s) => `[${s.n}] ${s.where}`).join('\n');
    this.#output = {
      kind: 'text',
      title: `Research: ${topic}`.slice(0, 200),
      text: `${synthesis}\n\nSources:\n${cites}`.slice(0, 8000),
      source: origin,
    };
    return this.#done(
      sources.length >= 2,
      `read ${sources.length} of ${results.length} source(s)${sources.length < 2 ? ' — fewer than two, reported as is' : ''}`,
    );
  }

  async #skillBookmarks(arg: string) {
    const [op = 'add', query = ''] = arg.split('|');
    const data = this.#data();
    if (op === 'search') {
      const found = await data.bookmarks.search(query);
      this.#output = {
        kind: 'list',
        title: `${found.length} bookmark(s)${query ? ` for "${query}"` : ''}`,
        entries: found.slice(0, 100).map((b) => `${b.title} — ${b.url}`),
      };
      return this.#done(true, `${found.length} bookmark(s) found`);
    }
    const page = await this.#page();
    const existing = (await data.bookmarks.search(page.clean)).filter(
      (b) => b.url.split(/[?#]/)[0] === page.clean,
    );
    if (op === 'remove') {
      if (existing.length === 0) return this.#done(false, 'this page is not bookmarked');
      if (existing.length > 1) {
        this.#output = {
          kind: 'list',
          title: 'Several bookmarks match — none removed',
          entries: existing.map((b) => `${b.title} — ${b.url}`),
        };
        return this.#done(
          false,
          `${existing.length} bookmarks match this page; remove the one you want yourself`,
        );
      }
      await data.bookmarks.remove(existing[0]!.id);
      const after = (await data.bookmarks.search(page.clean)).filter(
        (b) => b.url.split(/[?#]/)[0] === page.clean,
      );
      return this.#done(
        after.length === 0,
        after.length === 0 ? 'bookmark removed' : 'the bookmark is still there',
        page.host,
      );
    }
    if (existing.length > 0) return this.#done(true, 'already bookmarked', page.host);
    await data.bookmarks.add({ url: page.clean, title: page.title || page.host });
    const after = (await data.bookmarks.search(page.clean)).some(
      (b) => b.url.split(/[?#]/)[0] === page.clean,
    );
    this.#output = {
      kind: 'list',
      title: 'Bookmarked',
      entries: [`${page.title || page.host} — ${page.clean}`],
    };
    return this.#done(
      after,
      after ? 'bookmark added and read back' : 'the bookmark could not be read back',
      page.host,
    );
  }

  async #skillMonitor(arg: string) {
    const page = await this.#page();
    if (!page.clean.startsWith('https://'))
      return this.#done(false, 'only https pages can be monitored');
    // A number is a target price only with price wording ("below ₹50,000"), not "iPhone 15".
    const threshold =
      /(?:below|under|less\s+than|drops?\s+(?:to|below)|falls?\s+(?:to|below)|reaches|₹|rs\.?|inr)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|lakh)?/iu.exec(
        arg,
      );
    let value = threshold ? Number(threshold[1]!.replace(/,/g, '')) : null;
    if (value !== null && threshold?.[2]) value *= threshold[2].toLowerCase() === 'k' ? 1e3 : 1e5;
    const text = await this.deps.host.extractText?.(this.#tab).catch(() => null);
    const pricing = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d+)?)/iu.exec(
      [...(text?.headings ?? []), ...(text?.paragraphs ?? [])].join(' '),
    );
    const baseline = pricing ? Number(pricing[1]!.replace(/,/g, '')) : null;
    const monitor: Monitor = {
      monitorId: this.#newId('mon'),
      ownerId: 'local-user',
      url: page.clean,
      condition:
        value && value > 0
          ? { kind: 'price-below', threshold: value, currency: 'INR' }
          : /\b(?:back\s+in\s+stock|in\s+stock|available|availability|restock)/iu.test(arg)
            ? { kind: 'available' }
            : { kind: 'content-changed' },
      intervalMinutes: 60,
      status: 'active',
      recipientId: 'local-user',
      createdAt: this.#now(),
      lastCheckedAt: null,
    };
    const data = this.#data();
    const saved = await data.monitors.add(monitor, page.title ?? '');
    const stored = (await data.monitors.list()).some((x) => x.monitorId === monitor.monitorId);
    this.#output = {
      kind: 'list',
      title: 'Monitor saved',
      entries: [
        `Page: ${page.clean}`,
        monitor.condition.kind === 'price-below'
          ? `Notify when the price is at or below ₹${monitor.condition.threshold.toLocaleString('en-IN')}`
          : monitor.condition.kind === 'available'
            ? 'Notify when it is in stock'
            : 'Notify when the page changes',
        baseline !== null
          ? `Price now: ₹${baseline.toLocaleString('en-IN')}`
          : 'No price found on the page right now',
        saved?.note ??
          'Saved in this browser only. Connect the monitoring backend in Settings → Monitoring.',
      ],
    };
    return this.#done(
      stored,
      stored ? 'monitor stored and listed' : 'the monitor could not be stored',
      page.host,
    );
  }

  async #skillTabs(arg: string) {
    const data = this.#data();
    const tabs = (await data.tabs.list()).filter((t) => /^https?:/.test(t.url));
    const key = (u: string) => u.split('#')[0]!;
    const byUrl = new Map<string, typeof tabs>();
    for (const t of tabs) byUrl.set(key(t.url), [...(byUrl.get(key(t.url)) ?? []), t]);
    const duplicates = [...byUrl.values()].filter((g) => g.length > 1);
    if (arg === 'close-duplicates') {
      // Keep the active/pinned/first copy of each; never close pinned or active tabs.
      const close = duplicates.flatMap((g) => {
        const keep = g.find((t) => t.active) ?? g.find((t) => t.pinned) ?? g[0]!;
        return g.filter((t) => t !== keep && !t.pinned && !t.active).map((t) => t.id);
      });
      if (close.length) await data.tabs.close(close);
      const left = new Set((await data.tabs.list()).map((t) => t.id));
      const closed = close.filter((id) => !left.has(id)).length;
      this.#output = {
        kind: 'list',
        title: `Closed ${closed} duplicate tab(s)`,
        entries: duplicates.map((g) => `${g[0]!.title || g[0]!.url} — ${g.length} copies → 1`),
      };
      return this.#done(
        closed === close.length,
        `closed ${closed} of ${close.length} duplicate tab(s)`,
      );
    }
    const byHost = new Map<string, typeof tabs>();
    for (const t of tabs) {
      const host = new URL(t.url).hostname.replace(/^www\./, '');
      byHost.set(host, [...(byHost.get(host) ?? []), t]);
    }
    const entries = [...byHost.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([h, g]) => `${h}: ${g.length} tab(s)`);
    if (arg === 'duplicates') {
      this.#output = {
        kind: 'list',
        title: `${duplicates.length} page(s) open more than once`,
        entries: duplicates.map((g) => `${g[0]!.title || g[0]!.url} — ${g.length} copies`),
      };
      return this.#done(true, `${duplicates.length} duplicate group(s)`);
    }
    let grouped = 0;
    let supported = true;
    for (const [host, group] of byHost) {
      const ids = group.filter((t) => !t.pinned).map((t) => t.id);
      if (ids.length < 2) continue;
      if (await data.tabs.group(ids, host)) grouped += 1;
      else supported = false;
    }
    this.#output = {
      kind: 'list',
      title: supported
        ? `Grouped tabs by site (${grouped} group(s))`
        : 'This browser has no tab groups — tabs by site',
      entries: [
        ...entries,
        ...(duplicates.length
          ? [
              `${duplicates.length} page(s) are open more than once — say "close duplicate tabs" to close the extra copies`,
            ]
          : []),
      ],
    };
    return this.#done(
      true,
      supported
        ? `${grouped} group(s) created for ${tabs.length} tab(s)`
        : `listed ${tabs.length} tab(s) by site`,
    );
  }

  async #skillReadLater(arg: string) {
    const data = this.#data();
    if (arg === 'list') {
      const list = await data.readLater.list();
      this.#output = {
        kind: 'list',
        title: `${list.length} page(s) to read later`,
        entries: list.map((p) => `${p.title} — ${p.url}`),
      };
      return this.#done(true, `${list.length} saved page(s)`);
    }
    const page = await this.#page();
    if (arg === 'remove') {
      const removed = await data.readLater.remove(page.clean);
      return this.#done(
        removed,
        removed ? 'removed from read later' : 'this page was not in the read-later list',
        page.host,
      );
    }
    await data.readLater.add({
      url: page.clean,
      title: (page.title || page.host).slice(0, 300),
      savedAt: this.#now(),
    });
    const ok = (await data.readLater.list()).some((p) => p.url === page.clean);
    this.#output = {
      kind: 'list',
      title: 'Saved for later',
      entries: [`${page.title || page.host} — ${page.clean}`],
    };
    return this.#done(ok, ok ? 'saved (address and title only)' : 'could not be saved', page.host);
  }

  async #skillSavePage() {
    const page = await this.#page();
    const text = await this.deps.host.extractText?.(this.#tab).catch(() => null);
    if (!text || (text.paragraphs.length === 0 && text.headings.length === 0)) {
      throw new HandoverError('This page has no readable text to save.', 'ambiguous');
    }
    // A local file for the user; secrets and personal data are still redacted (privacy rules apply).
    const clean = (t: string) => redactForLog(t);
    const markdown = [
      `# ${clean(text.title || page.title)}`,
      '',
      `Source: ${page.clean}`,
      `Saved: ${new Date(this.#now()).toISOString()}`,
      '',
      ...text.headings.slice(1).map((h) => `## ${clean(h)}`),
      '',
      ...text.paragraphs.map((p) => `${clean(p)}\n`),
    ].join('\n');
    const slug =
      (text.title || page.host)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'page';
    const name = `${this.deps.settings.export.folder}/${slug}.md`;
    const ok = await this.#data().download({ name, mime: 'text/markdown', content: markdown });
    this.#output = {
      kind: 'list',
      title: ok ? `Saved ${name}` : 'Could not save the page',
      entries: [
        `${text.paragraphs.length} paragraph(s), ${markdown.length} characters`,
        'Personal data and secrets in the text were replaced by placeholders.',
      ],
    };
    return this.#done(ok, ok ? `saved ${name}` : 'the browser refused the download', page.host);
  }

  async #skillWalkthrough() {
    const capture = this.deps.host.captureVisible?.bind(this.deps.host);
    if (!capture) throw new HandoverError('Screenshots are not available here.', 'policy');
    const obs = await this.#observe();
    const top = obs.viewport.scrollY;
    const inView = (n: DOMNode) =>
      !!n.bbox && n.bbox.y >= top && n.bbox.y < top + obs.viewport.height;
    const injected = scanInjection(obs).nodeIds;
    const candidates = obs.domNodes.filter(
      (n) =>
        n.visible &&
        n.interactive &&
        inView(n) &&
        (n.name ?? n.text ?? '').trim() &&
        !injected.has(n.nodeId),
    );
    const search = candidates.filter(
      (n) => n.role === 'searchbox' || n.attributes['tm:form-role'] === 'search',
    );
    const rest = candidates
      .filter((n) => !search.includes(n))
      .sort((a, b) => b.bbox!.width * b.bbox!.height - a.bbox!.width * a.bbox!.height);
    const picked = [...search.slice(0, 1), ...rest]
      .slice(0, 6)
      .sort((a, b) => a.bbox!.y - b.bbox!.y || a.bbox!.x - b.bbox!.x);
    const shot = await capture(this.#tab, {
      people: this.deps.settings.privacy.faceBlurring,
      marks: picked.map((n, i) => ({ box: n.bbox!, label: String(i + 1) })),
    });
    if (!shot) return this.#done(false, 'the tab could not be captured (it must be visible)');
    const page = await this.#page();
    const name = `${this.deps.settings.export.folder}/${page.host}-walkthrough.png`;
    const ok = await this.#data().download({
      name,
      mime: 'image/png',
      content: shot.image.base64,
      base64: true,
    });
    const hint = (n: DOMNode) =>
      n.editable || n.role === 'searchbox'
        ? 'type here'
        : n.role === 'button' || n.tag === 'button'
          ? 'press to act'
          : n.role === 'link' || n.tag === 'a'
            ? 'opens a page'
            : 'interactive';
    this.#output = {
      kind: 'list',
      title: `Walkthrough of ${page.host}${ok ? ` — saved ${name}` : ''}`,
      entries: [
        ...picked.map(
          (n, i) =>
            `${i + 1}. ${redactForLog((n.name ?? n.text ?? '').trim()).slice(0, 80)} (${n.role ?? n.tag}) — ${hint(n)}`,
        ),
        `${shot.image.regions} sensitive region(s) were painted over in the screenshot.`,
      ],
    };
    return this.#done(
      ok && picked.length > 0,
      `${picked.length} region(s) marked; ${shot.image.regions} redacted; ${ok ? 'image saved' : 'save failed'}`,
      page.host,
    );
  }

  // ── context & website resolution ─────────────────────────────────────────────────────────

  #record(
    decision: {
      targetSource: NavigationDecision['targetSource'];
      navigationPolicy: NavigationDecision['navigationPolicy'];
      reuse: boolean;
    },
    context: TabContext | null,
    resolution: WebsiteResolution | null,
    reason: string,
  ): NavigationDecision {
    return {
      targetSource: decision.targetSource,
      navigationPolicy: decision.navigationPolicy,
      reusedTab: decision.reuse,
      contextOrigin: context?.origin ?? null,
      resolution,
      reason: reason.slice(0, 500),
    };
  }

  /** One observation of the open page: can it search, is it a media site? */
  async #assessContext(context: TabContext): Promise<ContextFit> {
    this.#tabId = context.tabId;
    try {
      const searchable = (o: Observation) =>
        groundSearchInput(o).length > 0 || groundSearchToggle(o).length > 0;
      let obs = await this.#observe();
      if (!searchable(obs)) {
        // The page may still be hydrating (header rendered by script): let it settle, look again.
        await this.#settle(null, CONTEXT_SETTLE_MS);
        obs = await this.#observe();
      }
      const canSearch = searchable(obs);
      const category = siteForDomain(context.host)?.category;
      // A known non-media site (a store) with product videos is still not where "play …" belongs.
      const hasMedia = category
        ? category === 'video' || category === 'music'
        : obs.domNodes.some((n) => n.tag === 'video' || n.tag === 'audio');
      this.#emit(
        'SYSTEM',
        `Current tab ${context.host}: ${canSearch ? 'has search' : 'no search'}${hasMedia ? ', media site' : ''}`,
        { host: context.host, canSearch, hasMedia },
      );
      return { canSearch, hasMedia };
    } catch (error) {
      // Pages the agent may not script (browser stores, PDFs…) cannot satisfy the request.
      this.#emit('SYSTEM', `Current tab ${context.host} cannot be inspected`, {
        host: context.host,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      return { canSearch: false, hasMedia: false };
    } finally {
      this.#tabId = null;
    }
  }

  /**
   * Resolve a website name: background probes first (fast, parallel, cookie-less). When every probe
   * is inconclusive — bot protection often resets non-browser connections, which the fetch API
   * cannot tell apart from a missing domain — confirm the most likely candidates in the task's
   * real tab, where the browser presents itself normally. `inTab` = the tab is now on the choice.
   */
  async #resolveWebsite(
    name: string,
    ensureTab: () => Promise<number>,
  ): Promise<{ resolution: WebsiteResolution; inTab: boolean }> {
    const region = this.deps.host.region();
    const key = `${name.toLowerCase()}|${region ?? ''}`;
    const cached = cachedResolution(key, this.#now());
    if (cached) {
      this.#emit('SYSTEM', `Website for "${name}": ${cached.chosen?.domain} (cached)`, {
        name,
        chosen: cached.chosen?.domain ?? null,
      });
      return { resolution: cached, inTab: false };
    }
    const candidates = websiteCandidates(name, region);
    this.#emit('SYSTEM', `Resolving website for "${name}" (${candidates.length} candidates)`, {
      name,
      candidates: candidates.join(', '),
    });
    const probes = candidates.length
      ? await this.deps.host.probeWebsites(candidates.map((d) => `https://${d}/`))
      : [];
    let resolution = resolveWebsite(name, candidates, probes);
    let inTab = false;

    if (!resolution.chosen && !resolution.ambiguous) {
      const inconclusive = resolution.candidates
        .filter((c) => c.verdict === 'unreachable')
        .slice(0, IN_TAB_CANDIDATES);
      for (const c of inconclusive) {
        const url = `https://${c.domain}/`;
        const tab = await ensureTab();
        this.#emit(
          'NAVIGATION_STARTED',
          `Checking ${c.domain} in the tab (background check was inconclusive)`,
          {
            url,
            purpose: 'website-resolution',
          },
        );
        const seen = await this.#checkInTab(tab, url);
        const index = probes.findIndex((p) => p.url === url);
        if (index < 0) continue;
        probes[index] = seen;
        const next = resolveWebsite(name, candidates, probes);
        // In-tab evidence counts only when the page names itself after the brand: an address
        // that merely loads something is not proof it is the site the user meant.
        if (next.candidates.find((x) => x.domain === c.domain)?.verdict === 'verified') {
          resolution = next;
          inTab = true;
          break;
        }
        probes[index] = { ...seen, status: null, error: 'page does not name itself after it' };
        resolution = resolveWebsite(name, candidates, probes);
      }
    }

    cacheResolution(key, resolution, this.#now());
    for (const c of resolution.candidates) {
      this.#emit('SYSTEM', `  ${c.domain}: ${c.verdict} (${c.score}) ${c.evidence}`, {
        domain: c.domain,
        verdict: c.verdict,
        score: c.score,
      });
    }
    this.#emit(
      'SYSTEM',
      resolution.chosen
        ? `Website for "${name}": ${resolution.chosen.domain}${resolution.ambiguous ? ' (ambiguous)' : ''}`
        : `No website could be confirmed for "${name}"`,
      { name, chosen: resolution.chosen?.domain ?? null, ambiguous: resolution.ambiguous },
    );
    return { resolution, inTab };
  }

  /**
   * Many bot walls are automatic JavaScript checks that pass on their own and reload the real page.
   * Give such a page a bounded moment to clear before treating it as a human-verification handover.
   */
  async #outwaitChallenge(
    probe: ProbeResponse | null,
    query: string | null,
  ): Promise<ProbeResponse | null> {
    if (!probe || !isChallengePage(probe, null, query)) return probe;
    this.#emit(
      'SYSTEM',
      `Waiting for an automatic access check on ${new URL(probe.url).hostname}`,
      {
        url: probe.url,
      },
    );
    const deadline = this.#clock() + CHALLENGE_WAIT_MS;
    let current: ProbeResponse | null = probe;
    while (current && isChallengePage(current, null, query) && this.#clock() < deadline) {
      const since: ProbeResponse = current;
      current =
        (await this.#timed('wait', () =>
          this.deps.host.settle(this.#tab, { since, timeoutMs: 4_000 }),
        )) ?? since;
    }
    if (current) this.#finalUrl = current.url;
    return current;
  }

  /** Load a candidate in the task tab and describe what the browser actually showed. */
  async #checkInTab(tab: number, url: string): Promise<WebsiteProbe> {
    const started = this.#clock();
    const base = { url, ms: 0 };
    try {
      // The candidate comes from the user's own words (the site name), so it may be visited.
      this.#allowedHosts.add(new URL(url).hostname);
      await this.#navigateGuarded(tab, url, 'checking a candidate website');
      const probe = await this.#outwaitChallenge(
        await this.deps.host.settle(tab, { since: null, timeoutMs: NAVIGATION_SETTLE_MS }),
        null,
      );
      const ms = this.#clock() - started;
      if (!probe) return { ...base, ms, status: null, finalUrl: null, body: '', error: 'no page' };
      this.#finalUrl = probe.url;
      // A browser-rendered title is the page's identity; a challenge page counts as gated.
      const status = isChallengePage(probe, null) ? 403 : 200;
      const title = probe.title.replace(/[<>&]/g, ' ');
      return {
        ...base,
        ms,
        status,
        finalUrl: probe.url,
        body: `<title>${title}</title>`,
        error: null,
      };
    } catch (error) {
      return {
        ...base,
        ms: this.#clock() - started,
        status: null,
        finalUrl: null,
        body: '',
        error: error instanceof Error ? error.message.slice(0, 200) : 'navigation failed',
      };
    }
  }

  // ── goals ────────────────────────────────────────────────────────────────────────────────

  /** Reuse the open tab: confirm it still shows the page the decision was made on. */
  async #useContext(goal: Extract<Goal, { kind: 'use-context' }>) {
    const probe = await this.deps.host.probe(this.#tab, null);
    if (!probe) {
      return {
        actionType: null,
        target: null,
        verified: false,
        evidence: 'the current tab no longer shows a web page',
      };
    }
    this.#finalUrl = probe.url;
    const host = new URL(probe.url).hostname;
    const same = hostMatchesDomain(host, goal.domain);
    return {
      actionType: null,
      target: host,
      verified: same,
      evidence: same
        ? `working in the open tab on ${host} — no navigation`
        : `the tab moved to ${host} before the task started`,
    };
  }

  async #navigate(goal: Extract<Goal, { kind: 'navigate' }>, ladder: RecoveryLadder) {
    for (;;) {
      this.#checkBudget();
      const current = await this.deps.host.probe(this.#tab, null);
      const action = bindNavigation({
        actionId: this.#newId('act'),
        taskId: this.task.taskId,
        tabId: this.#tab,
        observationId: this.#newId('tabstate'),
        current,
        url: goal.url,
        now: this.#now(),
      });
      this.#actions += 1;
      this.#emit('ACTION_PROPOSED', `NAVIGATE ${goal.url}`, {
        actionId: action.actionId,
        actionType: 'NAVIGATE',
        proposedBy: 'deterministic',
      });
      const decision = await this.#authorize(action, null);
      if (!decision.allowed) this.#refuse(decision, `opening ${goal.url}`);
      this.#emit('NAVIGATION_STARTED', `Direct navigation to ${goal.url}`, { url: goal.url });
      const after = await this.#timed('navigation', async () => {
        this.#inNavigation = true;
        try {
          await this.deps.host.navigate(this.#tab, goal.url);
          return await this.#settle(null, NAVIGATION_SETTLE_MS);
        } finally {
          this.#inNavigation = false;
        }
      });
      const landed = await this.#outwaitChallenge(after, null);
      if (landed && isChallengePage(landed, null)) {
        throw new HandoverError(challengeMessage(landed.url), 'policy', 'captcha');
      }
      const verdict = await this.#timed('verification', async () =>
        verifyNavigation(goal.domain, landed),
      );
      if (verdict.verified || ladder.used('retry')) {
        return { actionType: 'NAVIGATE' as const, target: goal.url, ...verdict };
      }
      ladder.decide(1, 'retry', 'retry', verdict.evidence, action.actionId);
    }
  }

  async #search(goal: Extract<Goal, { kind: 'search' }>, ladder: RecoveryLadder) {
    const excluded = new Set<string>();
    let submitVia: 'implicit' | 'button' = 'implicit';
    let lastEvidence = 'search not attempted';

    for (;;) {
      this.#checkBudget();
      const obs = await this.#observe();
      const injected = scanInjection(obs).nodeIds;
      const candidates = await this.#timed('grounding', async () =>
        groundSearchInput(obs).filter(
          (c) => !excluded.has(c.node.nodeId) && !injected.has(c.node.nodeId),
        ),
      );

      if (candidates.length === 0) {
        if (!ladder.used('refresh')) {
          ladder.decide(
            2,
            'refresh-observation',
            'refresh',
            'no search field grounded yet',
            `goal-search`,
          );
          // Wait for the page to CHANGE from what was just seen, not merely to be quiet: some sites
          // first serve an empty, quiet challenge document (seen live: HTTP 202) and replace it.
          const seen = await this.deps.host.probe(this.#tab, null).catch(() => null);
          await this.#settle(seen, ACTION_SETTLE_MS);
          continue;
        }
        // Still an (almost) empty document: a site check can take longer than one settle window
        // (seen live on a large store). Wait once more, bounded, before giving up.
        if (
          !ladder.used('refresh-empty') &&
          obs.domNodes.filter((n) => n.visible).length < 8 &&
          groundSearchToggle(obs).length === 0
        ) {
          ladder.decide(
            2,
            'refresh-observation',
            'refresh-empty',
            'the page is still empty (a site check may be running)',
            `goal-search`,
          );
          const seen = await this.deps.host.probe(this.#tab, null).catch(() => null);
          await this.#settle(seen, EMPTY_PAGE_WAIT_MS);
          continue;
        }
        if (!ladder.used('reveal')) {
          const toggle = groundSearchToggle(obs)[0];
          if (toggle) {
            ladder.decide(
              5,
              'alternative-strategy',
              'reveal',
              'search field is collapsed; opening it',
              `goal-search`,
            );
            this.#grounded('search toggle', toggle.node, toggle.score, toggle.reasons);
            const before = await this.deps.host.probe(this.#tab, null);
            await this.#execute(
              obs,
              toggle.node,
              { type: 'CLICK' },
              'Reveal the search field',
              { kind: 'element-visible', description: 'search field appears' },
              0.8,
            );
            await this.#settle(before, 3_000);
            continue;
          }
        }
        throw new HandoverError(
          excluded.size > 0 ? lastEvidence : 'No search field could be found on this page.',
          'ambiguous',
        );
      }

      const input = candidates[0]!;
      this.#grounded('search field', input.node, input.score, input.reasons);
      const before = await this.deps.host.probe(this.#tab, null);
      if (!before) throw new HandoverError('The tab no longer shows a web page.', 'policy');

      const typed = await this.#execute(
        obs,
        input.node,
        { type: 'TYPE', input: { text: goal.query }, submit: submitVia === 'implicit' },
        `Enter the query into the ${describeNode(input.node)}`,
        { kind: 'result-set-changed', description: `results for "${goal.query}"` },
        Math.min(1, input.score / 12),
      );

      if (typed.result.status !== 'executed') {
        const code = typed.result.code ?? 'FAILED';
        lastEvidence = `${code}: ${typed.result.message}`;
        if (REGROUND_CODES.has(code)) {
          ladder.decide(
            3,
            'reground',
            `reground-${ladder.decisions.length}`,
            `target changed before execution (${code})`,
            typed.action.actionId,
          );
        } else if (typed.result.status === 'failed' && !ladder.used('retry')) {
          ladder.decide(1, 'retry', 'retry', lastEvidence, typed.action.actionId);
        } else {
          excluded.add(input.node.nodeId);
          ladder.decide(
            4,
            'alternative-selector',
            `alt-${input.node.nodeId}`,
            lastEvidence,
            typed.action.actionId,
          );
        }
        continue;
      }

      if (!fieldHoldsQuery(typed.result.valueAfter, goal.query)) {
        lastEvidence = 'the field did not accept the query text';
        excluded.add(input.node.nodeId);
        ladder.decide(
          4,
          'alternative-selector',
          `alt-${input.node.nodeId}`,
          lastEvidence,
          typed.action.actionId,
        );
        continue;
      }

      if (submitVia === 'button') {
        const current = await this.#observe();
        const button = groundSearchSubmit(current, input.node)[0];
        if (!button) {
          lastEvidence = 'no submit control next to the search field';
          excluded.add(input.node.nodeId);
          ladder.decide(
            4,
            'alternative-selector',
            `alt-${input.node.nodeId}`,
            lastEvidence,
            typed.action.actionId,
          );
          submitVia = 'implicit';
          continue;
        }
        this.#grounded('search button', button.node, button.score, button.reasons);
        await this.#execute(
          current,
          button.node,
          { type: 'CLICK' },
          'Submit the search',
          { kind: 'result-set-changed', description: 'results render' },
          0.8,
        );
      }

      const settled = await this.#settle(before, ACTION_SETTLE_MS);
      if (!settled) throw new HandoverError('The tab no longer shows a web page.', 'policy');
      if (isChallengePage(settled, null, goal.query)) {
        const cleared = await this.#outwaitChallenge(settled, goal.query);
        if (!cleared || isChallengePage(cleared, null, goal.query)) {
          throw new HandoverError(challengeMessage(settled.url), 'policy', 'captcha');
        }
      }
      const verdict = await this.#awaitSearchResults(goal.query, before, obs, settled);
      if (verdict.verified) {
        return {
          actionType: 'TYPE' as const,
          target: describeNode(input.node),
          verified: true,
          evidence: verdict.evidence,
        };
      }
      lastEvidence = verdict.evidence;

      if (submitVia === 'implicit' && !ladder.used('submit-button')) {
        submitVia = 'button';
        ladder.decide(
          5,
          'alternative-strategy',
          'submit-button',
          `${verdict.evidence}; submitting with the search button`,
          typed.action.actionId,
        );
        continue;
      }
      excluded.add(input.node.nodeId);
      submitVia = 'implicit';
      ladder.decide(
        4,
        'alternative-selector',
        `alt-${input.node.nodeId}`,
        verdict.evidence,
        typed.action.actionId,
      );
    }
  }

  async #openResult(goal: Extract<Goal, { kind: 'open-result' }>, ladder: RecoveryLadder) {
    const excluded = new Set<string>();
    let lastEvidence = 'no result opened';
    for (;;) {
      this.#checkBudget();
      const obs = await this.#observe();
      // A follow-up ("play the first one") reads the query the page is showing results for.
      const query = goal.query ?? currentQuery(obs);
      // Elements that try to instruct the agent are never candidates (the firewall is the backstop).
      const injected = scanInjection(obs).nodeIds;
      let results = await this.#timed('grounding', async () =>
        rankResults(obs, query, goal.ordinal).filter(
          (r) =>
            !injected.has(r.node.nodeId) &&
            !excluded.has(`${r.node.name}|${r.node.attributes['href'] ?? ''}`),
        ),
      );
      if (results.length === 0) {
        if (!ladder.used('refresh')) {
          ladder.decide(
            2,
            'refresh-observation',
            'refresh',
            'no result links grounded yet',
            'goal-open-result',
          );
          await this.#settle(null, ACTION_SETTLE_MS);
          continue;
        }
      }
      if (results.length === 0 && !ladder.used('vision') && visionWorthTrying(obs)) {
        ladder.decide(
          5,
          'alternative-strategy',
          'vision',
          'no result is identifiable from the page structure; looking at the screen',
          'goal-open-result',
        );
        const which = goal.ordinal ? `result number ${goal.ordinal}` : 'the best result';
        const node = await this.#visualGround(
          `${which}${query ? ` for "${query}"` : ''} (a clickable item in the results list)`,
          obs,
        );
        if (node && !injected.has(node.nodeId)) {
          results = [{ node, score: 6, reasons: ['located visually'], matchedTerms: 0 }];
        }
      }
      if (results.length === 0) {
        throw new HandoverError(
          excluded.size ? lastEvidence : 'No matching result could be found.',
          'ambiguous',
        );
      }
      const best = results[0]!;
      this.#grounded('result', best.node, best.score, best.reasons);
      const before = await this.deps.host.probe(this.#tab, null);
      if (!before) throw new HandoverError('The tab no longer shows a web page.', 'policy');
      const openedBefore = await this.#openedTabs();
      const proposer = this.#proposer;
      if (best.reasons.includes('located visually')) this.#proposer = 'vision';
      const clicked = await this.#execute(
        obs,
        best.node,
        { type: 'CLICK' },
        `Open ${describeNode(best.node)}`,
        { kind: goal.media ? 'media-playing' : 'url-changed', description: 'result opens' },
        Math.min(1, best.score / 12),
        // A trusted click gives the page a real user gesture, so the video may start with sound.
        { trusted: goal.media && this.deps.settings.agent.trustedMediaClicks },
      );
      this.#proposer = proposer;
      if (clicked.result.status !== 'executed') {
        lastEvidence = `${clicked.result.code}: ${clicked.result.message}`;
        ladder.decide(
          3,
          'reground',
          `reground-${ladder.decisions.length}`,
          lastEvidence,
          clicked.action.actionId,
        );
        continue;
      }
      // A result may open in a new tab (target="_blank"): look briefly for the same tab changing,
      // then for a tab opened by the click — and switch to it instead of clicking again.
      let after = await this.#settle(before, NEW_TAB_CHECK_MS);
      if (!after || samePage(before, after)) {
        const adopted = await this.#adoptOpenedTab(openedBefore);
        after = adopted ?? (await this.#settle(before, ACTION_SETTLE_MS - NEW_TAB_CHECK_MS));
      }
      if (after && isChallengePage(after, null, query)) {
        const cleared = await this.#outwaitChallenge(after, query);
        if (!cleared || isChallengePage(cleared, null, query)) {
          throw new HandoverError(challengeMessage(after.url), 'policy', 'captcha');
        }
      }
      let verdict = goal.media
        ? await this.#verifyPlayback(before, after)
        : verifyOpenResult({ before, after, media: false });
      if (
        !verdict.verified &&
        goal.media &&
        after &&
        after.url !== before.url &&
        after.media.present &&
        !ladder.used('press-play')
      ) {
        // L5: the main player is there but not playing (e.g. autoplay blocked) — press its Play control.
        const played = await this.#pressPlay(ladder, clicked.action.actionId);
        if (played)
          verdict = await this.#verifyPlayback(before, await this.deps.host.probe(this.#tab, null));
      }
      if (verdict.verified) {
        return { actionType: 'CLICK' as const, target: describeNode(best.node), ...verdict };
      }
      lastEvidence = verdict.evidence;
      if (goal.media && after && after.url !== before.url && after.media.present) {
        // The right kind of page with a real player that will not start: the browser's autoplay
        // policy needs a genuine user gesture, which an extension cannot fabricate. Trying other
        // results would not help — hand over with a precise instruction instead.
        throw new HandoverError(
          `Opened ${after.title || after.url} — the browser blocked automatic playback. Press Play in the tab to start it.`,
          'policy',
        );
      }
      excluded.add(`${best.node.name}|${best.node.attributes['href'] ?? ''}`);
      if (after && after.url !== before.url) {
        // Return to the results to try the next candidate. History back first; if the browser
        // has no usable history entry, navigate straight back to the results URL.
        try {
          await this.deps.host.goBack(this.#tab);
        } catch {
          await this.#navigateGuarded(this.#tab, before.url, 'returning to the results');
        }
        await this.#settle(after, ACTION_SETTLE_MS);
      }
      ladder.decide(
        4,
        'alternative-selector',
        `alt-${ladder.decisions.length}`,
        lastEvidence,
        clicked.action.actionId,
      );
    }
  }

  /**
   * Results often render after the URL/title change (client-side fetch). Re-observe until relevant
   * results are actually visible, bounded by RESULTS_WAIT_MS; only then accept the verdict. A
   * title-only match is accepted only if no result list ever appears within the window.
   */
  async #awaitSearchResults(
    query: string,
    before: ProbeResponse,
    beforeObs: Observation,
    settled: ProbeResponse,
  ) {
    const deadline = this.#clock() + RESULTS_WAIT_MS;
    let after = settled;
    for (;;) {
      const afterObs = await this.#observe();
      const verdict = await this.#timed('verification', async () =>
        verifySearch({ query, before, beforeObs, after, afterObs }),
      );
      const pageMoved = after.url !== before.url || verdict.relevantResults > 0;
      if (verdict.relevantResults > 0 || !pageMoved || this.#clock() >= deadline) return verdict;
      await this.#timed('wait', () => new Promise((r) => setTimeout(r, RESULTS_POLL_MS)));
      after = (await this.deps.host.probe(this.#tab, null)) ?? after;
    }
  }

  /** Media goals: sustained playback of the primary player, sampled twice over PLAYBACK_SAMPLE_MS. */
  async #verifyPlayback(before: ProbeResponse, after: ProbeResponse | null) {
    return this.#timed('verification', async () => {
      if (!after || after.url === before.url || !after.media.present) {
        return verifyOpenResult({ before, after, media: true });
      }
      const deadline = this.#clock() + MEDIA_WAIT_MS;
      let first: ProbeResponse | null = after;
      for (;;) {
        await new Promise((r) => setTimeout(r, PLAYBACK_SAMPLE_MS));
        const later = await this.deps.host.probe(this.#tab, null);
        const verdict = verifyOpenResult({ before, after: first, media: true, later });
        if (verdict.verified || this.#clock() >= deadline || !later) return verdict;
        first = later;
      }
    });
  }

  /** Ground and click a visible Play control of the page's player (generic: accessible name). */
  async #pressPlay(ladder: RecoveryLadder, actionId: string): Promise<boolean> {
    const obs = await this.#observe();
    const play = obs.domNodes.find(
      (n) =>
        n.visible &&
        n.interactive &&
        (n.role === 'button' || n.tag === 'button') &&
        /^(play|resume)\b/i.test(n.name ?? ''),
    );
    if (!play) return false;
    ladder.decide(
      5,
      'alternative-strategy',
      'press-play',
      'player is paused; pressing its Play control',
      actionId,
    );
    this.#grounded('play control', play, 5, ['button named Play']);
    const { result } = await this.#execute(
      obs,
      play,
      { type: 'CLICK' },
      'Start playback',
      { kind: 'media-playing', description: 'media plays' },
      0.8,
      { trusted: this.deps.settings.agent.trustedMediaClicks },
    );
    return result.status === 'executed';
  }
}
