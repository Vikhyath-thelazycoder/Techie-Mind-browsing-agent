import {
  Action,
  elementFingerprint,
  TARGETED_ACTIONS,
  type DOMNode,
  type Observation,
  type ProbeResponse,
} from '@techie-mind/contracts';
import { detectText } from '@techie-mind/privacy';
import { atLeast, classifyRisk, type RiskAssessment, type RiskClass } from './risk.js';

/**
 * The local action firewall (plan §23, spec §23). Models and planners only PROPOSE; this decides.
 * Every action passes, in order:
 *
 *   schema → task binding → tab binding → target → origin → freshness (stale) → risk → privacy
 *   → injection / provenance → authorization → EXECUTE
 *
 * The first failing check rejects the action. Page content is DATA, never instructions: an action
 * is only authorized if it follows from the user's own request (provenance), whatever the page says.
 */

export const FIREWALL_CHECKS = [
  'schema',
  'task-binding',
  'tab-binding',
  'target',
  'origin',
  'freshness',
  'risk',
  'privacy',
  'injection',
  'authorization',
] as const;
export type FirewallCheck = (typeof FIREWALL_CHECKS)[number];

export interface FirewallContext {
  taskId: string;
  /** The tab the task owns. */
  tabId: number;
  /** The observation the action was bound to (null only for NAVIGATE). */
  observation: Observation | null;
  /** The tab's live state, probed right before execution (null = no web page). */
  live: ProbeResponse | null;
  /** The user's own words — the only source of authority for what to type and where to go. */
  userText: string;
  /** Hosts/registrable domains this task may navigate to (routed target, open tab, discovery). */
  allowedHosts: readonly string[];
  /** Actions at or above this risk need explicit confirmation (settings.agent.confirmAtRisk). */
  confirmAt: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  now: number;
  /** Local vault lookups (tokens only — never values). */
  vault?: { has(token: string): boolean } | null;
  /** Oldest acceptable observation. */
  maxObservationAgeMs?: number;
  /** When the runtime received the observation (its own clock); defaults to observation.createdAt. */
  observedAt?: number;
}

export interface FirewallDecision {
  allowed: boolean;
  /** The check that rejected the action, or "authorization" when everything passed. */
  check: FirewallCheck;
  passed: FirewallCheck[];
  risk: RiskAssessment | null;
  reasons: string[];
  /** Set when the right outcome is to hand control to the user rather than fail. */
  handover: RiskAssessment['handover'] | 'confirmation' | null;
}

// ── prompt injection ───────────────────────────────────────────────────────────────────────

const INJECTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,30}\b(?:previous|prior|above|earlier|all|your|the)\b[^.]{0,20}\b(?:instructions?|prompts?|messages?|rules|directions)\b/i,
  /\b(?:you are now|from now on you|act as (?:an?|the)|new (?:system )?instructions?\s*:|system prompt|developer mode|jailbreak)/i,
  /\b(?:send|share|reveal|email|post|type|enter|paste|give)\b[^.]{0,25}\b(?:password|credentials?|otp|one[- ]time|api key|secret|token|cookies?|card (?:number|details)|cvv|aadhaa?r)\b[^.]{0,40}\b(?:to|into|at|in|here|below)\b/i,
  /<\/?\s*(?:system|instructions?|assistant)\s*>/i,
  /\b(?:ai|assistant|agent|bot|llm)\b[^.]{0,20}\b(?:must|should|needs to|has to)\b[^.]{0,40}\b(?:click|navigate|go to|visit|type|enter|send|buy|pay)\b/i,
];

/**
 * Count text blocks (lines/paragraphs) of rendered page text that try to instruct the agent. Runs
 * inside the page with the whole-page privacy scan; only the count leaves the page.
 */
export function countInjectionText(text: string): number {
  let n = 0;
  for (const block of text.split(/\n+/)) {
    if (block.length >= 12 && INJECTION.some((re) => re.test(block))) n += 1;
  }
  return n;
}

export interface InjectionScan {
  /** Nodes whose text carries instructions aimed at an automated agent. */
  nodeIds: Set<string>;
  /** Of those, how many are hidden from the user (a classic injection trick). */
  hidden: number;
}

/** Find page text that tries to instruct the agent. It is reported and never obeyed. */
export function scanInjection(obs: Observation | null): InjectionScan {
  const nodeIds = new Set<string>();
  let hidden = 0;
  if (!obs) return { nodeIds, hidden };
  for (const node of obs.domNodes) {
    const text = `${node.name ?? ''} ${node.text ?? ''} ${node.attributes['title'] ?? ''}`;
    if (text.length < 12) continue;
    if (INJECTION.some((re) => re.test(text))) {
      nodeIds.add(node.nodeId);
      if (!node.visible) hidden += 1;
    }
  }
  return { nodeIds, hidden };
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────

const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function hostMatches(host: string, allowed: string): boolean {
  const h = host.toLowerCase();
  const a = allowed.toLowerCase().replace(/^www\./, '');
  return h === a || h.endsWith(`.${a}`) || h.replace(/^www\./, '') === a;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const RISK_OF_SETTING: Record<FirewallContext['confirmAt'], RiskClass> = {
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'HUMAN_REQUIRED',
};

const DEFAULT_MAX_AGE_MS = 120_000;

export class ActionFirewall {
  evaluate(candidate: unknown, ctx: FirewallContext): FirewallDecision {
    const passed: FirewallCheck[] = [];
    let risk: RiskAssessment | null = null;
    const deny = (
      check: FirewallCheck,
      reason: string,
      handover: FirewallDecision['handover'] = null,
    ): FirewallDecision => ({ allowed: false, check, passed, risk, reasons: [reason], handover });
    const pass = (check: FirewallCheck) => passed.push(check);

    // 1. schema
    const parsed = Action.safeParse(candidate);
    if (!parsed.success) return deny('schema', parsed.error.issues[0]?.message ?? 'not an Action');
    const action = parsed.data;
    const b = action.binding;
    pass('schema');

    // 2. task binding
    if (b.taskId !== ctx.taskId) return deny('task-binding', 'action belongs to another task');
    pass('task-binding');

    // 3. tab binding (cross-tab safety)
    if (b.tabId !== ctx.tabId) return deny('tab-binding', 'action is bound to another tab');
    pass('tab-binding');

    // 4. target
    let target: DOMNode | null = null;
    if (b.target) {
      if (b.target.kind !== 'element') return deny('target', 'visual targets are not enabled yet');
      if (!ctx.observation || ctx.observation.observationId !== b.observationId) {
        return deny('target', 'the observation this action was planned on is not available');
      }
      const elementId = b.target.elementId;
      target = ctx.observation.domNodes.find((n) => n.nodeId === elementId) ?? null;
      if (!target) return deny('target', 'target element is not in the observation');
      if (
        b.target.fingerprint !== null &&
        b.target.fingerprint !== elementFingerprint(target.tag, target.role, target.name)
      ) {
        return deny('target', 'target identity does not match its fingerprint');
      }
      if (!target.visible) return deny('target', 'target is not visible');
      if (action.args.type === 'TYPE' && !target.editable) {
        return deny('target', 'target does not accept text');
      }
    } else if (TARGETED_ACTIONS.has(action.args.type)) {
      return deny('target', `${action.args.type} needs a target`);
    }
    pass('target');

    // 5. origin
    if (action.args.type === 'NAVIGATE') {
      const host = hostOf(action.args.url);
      if (!host) return deny('origin', 'invalid navigation URL');
      if (!ctx.allowedHosts.some((a) => hostMatches(host, a))) {
        return deny('origin', `navigation to ${host} was not requested by the user`);
      }
    } else {
      if (!ctx.live) return deny('origin', 'the tab no longer shows a web page');
      if (b.origin !== ctx.live.origin) {
        return deny('origin', `page origin changed (${b.origin ?? 'none'} → ${ctx.live.origin})`);
      }
    }
    pass('origin');

    // 6. freshness (stale observation / page replaced under us)
    if (action.args.type !== 'NAVIGATE') {
      if (!ctx.live || ctx.live.documentId !== b.documentId) {
        return deny('freshness', 'the page was replaced since it was observed');
      }
      if (ctx.live.version < b.observationVersion) {
        return deny('freshness', 'observation is newer than the page (forged or reordered)');
      }
      if (ctx.observation) {
        const age = ctx.now - (ctx.observedAt ?? ctx.observation.createdAt);
        if (age > (ctx.maxObservationAgeMs ?? DEFAULT_MAX_AGE_MS)) {
          return deny('freshness', `observation is ${Math.round(age / 1000)} s old`);
        }
      }
    }
    pass('freshness');

    // 7. risk
    risk = classifyRisk(action, target);
    if (risk.level === 'BLOCKED') return deny('risk', risk.reasons.join('; '));
    pass('risk');

    // 8. privacy — the agent never types personal data the user did not give it.
    if (action.args.type === 'TYPE') {
      const input = action.args.input;
      if ('vaultToken' in input) {
        if (!ctx.vault?.has(input.vaultToken)) {
          return deny('privacy', 'unknown or expired vault token');
        }
      } else {
        const user = normalize(ctx.userText);
        for (const d of detectText(input.text)) {
          const value = normalize(input.text.slice(d.start, d.end));
          if (!user.includes(value)) {
            return deny(
              'privacy',
              `would type ${d.kind.replace('_', ' ')} the user did not provide`,
            );
          }
        }
      }
    }
    pass('privacy');

    // 9. injection / provenance — page text is data, not instructions.
    const injected = scanInjection(ctx.observation);
    if (target && injected.nodeIds.has(target.nodeId)) {
      return deny('injection', 'target carries instructions aimed at the agent');
    }
    if (action.args.type === 'TYPE' && 'text' in action.args.input) {
      const typed = normalize(action.args.input.text);
      if (typed && !normalize(ctx.userText).includes(typed)) {
        return deny('injection', 'text to type does not come from the user request');
      }
    }
    pass('injection');

    // 10. authorization
    if (risk.level === 'HUMAN_REQUIRED') {
      return deny('authorization', risk.reasons.join('; '), risk.handover);
    }
    const userRequested =
      action.args.type === 'NAVIGATE' || (action.args.type === 'TYPE' && risk.level === 'LOW');
    if (!userRequested && atLeast(risk.level, RISK_OF_SETTING[ctx.confirmAt])) {
      return deny(
        'authorization',
        `${risk.reasons.join('; ')} — needs your confirmation`,
        'confirmation',
      );
    }
    pass('authorization');
    return {
      allowed: true,
      check: 'authorization',
      passed,
      risk,
      reasons: risk.reasons,
      handover: null,
    };
  }
}
