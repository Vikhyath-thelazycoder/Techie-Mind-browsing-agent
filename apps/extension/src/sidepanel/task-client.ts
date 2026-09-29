import {
  decideNavigation,
  describeGoal,
  needsContextFit,
  matchCustomSkill,
  needsModel,
  planGoals,
  resolveIntent,
  SKILL_ARG_ENTITY,
  SKILL_ENTITY,
  type TabContext,
} from '@techie-mind/agent-core';
import type { BrowserAdapter } from '@techie-mind/browser';
import {
  ControlTaskRequest,
  ResumeTaskRequest,
  RunTaskRequest,
  TASK_PORT,
  TaskPortMessage,
  type AuditEvent,
  type CustomSkill,
  type IntentProfile,
  type TaskMode,
  type TaskResult,
} from '@techie-mind/contracts';
import { useCallback, useRef, useState } from 'preact/hooks';
import { loadSkills } from '../shared/skills-store.js';

const KEEPALIVE_MS = 15_000;

export interface PlanPreview {
  text: string;
  intent: IntentProfile;
  destination: string | null;
  steps: string[];
  problem: string | null;
  /** Code is unsure: the local models will be asked when it runs. */
  needsModel?: boolean;
  /** Name of the user's own skill this request starts, if any. */
  skill?: string;
}

/**
 * Local, model-free preview of what the agent will do ("Ask before acting"). Uses the same
 * deterministic resolver the background uses; the background re-resolves when it runs.
 */
export function previewPlan(
  text: string,
  context: TabContext | null = null,
  custom: readonly CustomSkill[] = [],
): PlanPreview {
  const { profile } = resolveIntent(text);
  // One of the user's own skills (Settings → Skills): show its steps, each run as if typed.
  const own = matchCustomSkill(text, custom);
  if (own) {
    return {
      text,
      intent: profile,
      destination: null,
      steps: [
        ...own.steps.map((step, i) => `Step ${i + 1}: ${step}`),
        'Stop at the first step that does not complete',
      ],
      problem: null,
      skill: own.skill.name,
    };
  }
  // Built-in skills act on the open page and skip the website router, exactly as the runner does.
  if (profile.action === 'skill') {
    const id = profile.entities.find((e) => e.type === SKILL_ENTITY)?.value ?? '';
    const arg = profile.entities.find((e) => e.type === SKILL_ARG_ENTITY)?.value ?? '';
    const skill = describeGoal({ kind: 'skill', id, arg } as Parameters<typeof describeGoal>[0]);
    return {
      text,
      intent: profile,
      destination: null,
      steps: [
        ...(context ? [`Use the current tab (${context.host})`] : []),
        skill,
        'Verify the result',
      ],
      problem: null,
    };
  }
  // Code is unsure ("now open the samsung one"): the local models decide when it runs. The preview
  // must not block that with a code-only "could not understand".
  if (needsModel(profile)) {
    return {
      text,
      intent: profile,
      destination: null,
      steps: [
        'Ask the local AI what you mean (Laya, then the local model)',
        context
          ? `Act on the open page (${context.host}), or ask you which one`
          : 'Act on it, or ask you',
        'Verify the result',
      ],
      problem: null,
      needsModel: true,
    };
  }
  // The panel cannot inspect the page; assume the open page can search. The background decides
  // for real (it observes the page) and falls back to another destination when it cannot.
  const fit = context ? { canSearch: true, hasMedia: true } : null;
  const route = decideNavigation(profile, context, needsContextFit(profile, context) ? fit : null);
  if (!route.ok)
    return { text, intent: profile, destination: null, steps: [], problem: route.message };
  const verify = 'Verify the result';
  if (route.resolveName) {
    const plan = planGoals(profile, PLACEHOLDER_TARGET);
    const rest = plan.ok ? plan.goals.slice(1).map(describeGoal) : [];
    return {
      text,
      intent: profile,
      destination: null,
      steps: [`Find the official website for "${route.resolveName}"`, ...rest, verify],
      problem: plan.ok ? null : plan.message,
    };
  }
  const target = route.target!;
  const plan = planGoals(profile, target, route.reuse);
  if (!plan.ok)
    return { text, intent: profile, destination: target.url, steps: [], problem: plan.message };
  return {
    text,
    intent: profile,
    destination: target.url,
    steps: [...plan.goals.map(describeGoal), verify],
    problem: null,
  };
}

/** Stand-in destination while a website name is still to be resolved (preview only). */
const PLACEHOLDER_TARGET = {
  domain: 'resolved.website',
  url: 'https://resolved.website/',
  adapterId: null,
  reason: 'resolved-website',
} as const;

/** The active web tab as a task context (preview only; no page access). */
async function activeContext(adapter: BrowserAdapter): Promise<TabContext | null> {
  try {
    const tab = await adapter.activeTab();
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) return null;
    const url = new URL(tab.url);
    return {
      tabId: tab.id,
      url: tab.url,
      origin: url.origin,
      host: url.hostname,
      title: tab.title ?? '',
      source: 'active-tab',
    };
  } catch {
    return null;
  }
}

export type RunPhase = 'idle' | 'preview' | 'running' | 'done';

export interface RunState {
  phase: RunPhase;
  text: string;
  preview: PlanPreview | null;
  events: AuditEvent[];
  result: TaskResult | null;
  error: string | null;
}

const IDLE: RunState = {
  phase: 'idle',
  text: '',
  preview: null,
  events: [],
  result: null,
  error: null,
};

/** Runs tasks in the background over the task port and streams progress into UI state. */
export function useTaskRunner(adapter: BrowserAdapter) {
  const [state, setState] = useState<RunState>(IDLE);
  const cleanup = useRef<(() => void) | null>(null);
  const portRef = useRef<ReturnType<BrowserAdapter['connect']> | null>(null);

  const reset = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    setState(IDLE);
  }, []);

  const preview = useCallback(
    (text: string) => {
      setState({ ...IDLE, phase: 'preview', text, preview: previewPlan(text) });
      void Promise.all([activeContext(adapter), loadSkills(adapter)]).then(([context, skills]) => {
        setState((s) =>
          s.phase === 'preview' && s.text === text
            ? { ...s, preview: previewPlan(text, context, skills.custom) }
            : s,
        );
      });
    },
    [adapter],
  );

  /** Open a task port, send one request, and stream the task's events and result into state. */
  const start = useCallback(
    (text: string, request: RunTaskRequest | ResumeTaskRequest, keepEvents: boolean) => {
      cleanup.current?.();
      setState((s) => ({
        ...IDLE,
        phase: 'running',
        text,
        events: keepEvents ? s.events : [],
      }));
      const port = adapter.connect(TASK_PORT);
      portRef.current = port;
      const keepAlive = setInterval(() => port.post({ type: 'KEEPALIVE' }), KEEPALIVE_MS);
      let finished = false;
      const stop = () => {
        clearInterval(keepAlive);
        finished = true;
      };
      cleanup.current = () => {
        stop();
        port.disconnect();
        if (portRef.current === port) portRef.current = null;
      };
      port.onMessage((raw) => {
        const message = TaskPortMessage.safeParse(raw);
        if (!message.success) return;
        const m = message.data;
        if (m.type === 'TASK_EVENT') {
          setState((s) => ({ ...s, events: [...s.events, m.event] }));
        } else if (m.type === 'TASK_RESULT') {
          stop();
          setState((s) => ({ ...s, phase: 'done', result: m.result }));
        } else {
          stop();
          setState((s) => ({ ...s, phase: 'done', error: `${m.code}: ${m.message}` }));
        }
      });
      port.onDisconnect(() => {
        if (!finished) {
          stop();
          setState((s) => ({ ...s, phase: 'done', error: 'Lost connection to the agent.' }));
        }
      });
      port.post(request);
    },
    [adapter],
  );

  const run = useCallback(
    (text: string, mode: TaskMode, source: RunTaskRequest['source'] = 'typed') =>
      start(text, RunTaskRequest.parse({ type: 'RUN_TASK', text, mode, source }), false),
    [start],
  );

  /** Pause or stop the running task; it takes effect before the agent's next step. */
  const control = useCallback((action: ControlTaskRequest['action']) => {
    portRef.current?.post(ControlTaskRequest.parse({ type: 'CONTROL_TASK', action }));
  }, []);

  /** Continue (or approve / discard) a task that stopped for you. */
  const resume = useCallback(
    (taskId: string, decision: ResumeTaskRequest['decision']) => {
      const request = ResumeTaskRequest.parse({ type: 'RESUME_TASK', taskId, decision });
      if (decision === 'discard') {
        const port = adapter.connect(TASK_PORT);
        port.post(request);
        setTimeout(() => port.disconnect(), 500);
        setState((s) => ({ ...s, result: s.result ? { ...s.result, handover: null } : null }));
        return;
      }
      start(state.text, request, true);
    },
    [adapter, start, state.text],
  );

  return { state, preview, run, reset, control, resume };
}
