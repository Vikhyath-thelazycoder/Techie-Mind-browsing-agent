import type { Settings } from '@techie-mind/config';
import {
  RecoveryDecision,
  Target,
  TaskResult,
  type Action,
  type ActionArgs,
  type AuditEventType,
  type DOMNode,
  type ExecuteResponse,
  type ExpectedOutcome,
  type IntentProfile,
  type NavigationDecision,
  type Observation,
  type PrivacySummary,
  type ProbeResponse,
  type StageTimings,
  type StepReport,
  type Task,
  type TaskStatus,
  type WebsiteProbe,
  type WebsiteResolution,
} from '@techie-mind/contracts';
import { sanitizeObservation, TokenVault } from '@techie-mind/privacy';
import { ActionFirewall, scanInjection, type FirewallDecision } from '@techie-mind/security';
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
import { resolveIntent } from './intent.js';
import { describeGoal, planGoals, type Goal } from './plan.js';
import {
  decideNavigation,
  discoveryTarget,
  needsContextFit,
  type ContextFit,
  type TabContext,
} from './router.js';
import { hostMatchesDomain, siteForDomain } from './sites.js';
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
  | 'wait';

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
const NAVIGATION_SETTLE_MS = 20_000;
const ACTION_SETTLE_MS = 8_000;
/** How long a clicked result may leave its tab unchanged before we look for a tab it opened. */
const NEW_TAB_CHECK_MS = 2_000;

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
  async #authorize(action: Action, obs: Observation | null): Promise<FirewallDecision> {
    return this.#timed('firewall', async () => {
      const live = await this.deps.host.probe(this.#tab, null).catch(() => null);
      const decision = this.#firewall.evaluate(action, {
        taskId: this.task.taskId,
        tabId: this.#tab,
        observation: obs,
        live,
        userText: this.task.text,
        allowedHosts: [...this.#allowedHosts],
        confirmAt: this.deps.settings.agent.confirmAtRisk,
        now: this.#now(),
        vault: this.#vault,
        ...(obs ? { observedAt: this.#observedAt.get(obs.observationId) ?? this.#now() } : {}),
      });
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
    throw new HandoverError(message, 'policy');
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
      proposedBy: 'deterministic',
      now: this.#now(),
    });
    this.#emit('ACTION_PROPOSED', `${args.type}${target ? ` ${describeNode(target)}` : ''}`, {
      actionId: action.actionId,
      actionType: args.type,
      proposedBy: 'deterministic',
    });
    this.#actions += 1;
    const decision = await this.#authorize(action, obs);
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
    const result = await this.#timed('action', () => this.deps.host.execute(this.#tab, action));
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

  async run(): Promise<TaskResult> {
    this.#emit('TASK_STARTED', this.task.text, { source: this.task.source, mode: this.task.mode });
    try {
      const { profile } = await this.#timed('intent', async () => resolveIntent(this.task.text));
      this.#intent = profile;
      this.#emit(
        'INTENT_RESOLVED',
        `${profile.intent}${profile.query ? ` · "${profile.query}"` : ''}`,
        {
          intent: profile.intent,
          action: profile.action,
          domain: profile.targetDomain,
          query: profile.query,
          language: profile.language,
          confidence: profile.confidence,
          resolvedBy: profile.resolvedBy,
          modelCalls: 0,
        },
      );

      // Where to act — decided BEFORE any navigation, from the wording and the open tab.
      const context = await this.#timed('context', () => this.deps.host.currentContext());
      // The open tab's site is part of the user's context; recovery may return to it.
      if (context) this.#allowedHosts.add(context.host);
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
      for (const goal of plan.goals) {
        const report = await this.#achieve(goal);
        this.#steps.push(report);
        if (!report.verified) {
          const handover = report.recovery.some((r) => r.strategy === 'handover');
          this.#emit('HANDOVER_REQUIRED', report.evidence, { goal: goal.kind }, 'warn');
          return this.#finish(handover ? 'HUMAN_REQUIRED' : 'FAILED', {
            code: 'GOAL_NOT_VERIFIED',
            message: `${describeGoal(goal)}: ${report.evidence}`,
          });
        }
      }
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
    try {
      const outcome =
        goal.kind === 'use-context'
          ? await this.#useContext(goal)
          : goal.kind === 'navigate'
            ? await this.#navigate(goal, ladder)
            : goal.kind === 'search'
              ? await this.#search(goal, ladder)
              : await this.#openResult(goal, ladder);
      this.#verified(outcome.verified, outcome.evidence, goal);
      return {
        ...base,
        ...outcome,
        attempts: ladder.decisions.length + 1,
        recovery: ladder.decisions,
      };
    } catch (error) {
      if (error instanceof BudgetError) throw error;
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
      const hasMedia =
        category === 'video' ||
        category === 'music' ||
        obs.domNodes.some((n) => n.tag === 'video' || n.tag === 'audio');
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
        throw new HandoverError(challengeMessage(landed.url), 'policy');
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
          await this.#settle(null, ACTION_SETTLE_MS);
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
          throw new HandoverError(challengeMessage(settled.url), 'policy');
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
      const results = await this.#timed('grounding', async () =>
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
      const clicked = await this.#execute(
        obs,
        best.node,
        { type: 'CLICK' },
        `Open ${describeNode(best.node)}`,
        { kind: goal.media ? 'media-playing' : 'url-changed', description: 'result opens' },
        Math.min(1, best.score / 12),
      );
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
          throw new HandoverError(challengeMessage(after.url), 'policy');
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
    );
    return result.status === 'executed';
  }
}
