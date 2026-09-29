import {
  matchCustomSkill,
  resumeTask,
  runTask,
  type AgentHost,
  type TaskCheckpoint,
} from '@techie-mind/agent-core';
import { loadSkills } from '../shared/skills-store.js';
import type { BrowserAdapter, Port } from '@techie-mind/browser';
import type { Intelligence } from '@techie-mind/models';
import { parseSettings, SETTINGS_STORAGE_KEY, type Settings } from '@techie-mind/config';
import {
  HISTORY_LIMIT,
  HISTORY_STORAGE_KEY,
  Task,
  TASK_PORT,
  TaskPortRequest,
  TaskResult,
  type AuditEvent,
  type TaskPortMessage,
} from '@techie-mind/contracts';
import { redactForLog, safeUrl } from '@techie-mind/privacy';
import {
  createLogger,
  MemorySink,
  type LogSink,
  type Logger,
  type PersistentAuditLog,
} from '@techie-mind/telemetry';

/**
 * Task service: accepts RUN_TASK over the task port from this extension's own pages only, runs the
 * agent core, streams structured events to the page, and records the result in history.
 * One task at a time — a second request while busy is refused, not queued silently.
 */
export function startTaskService(deps: {
  adapter: BrowserAdapter;
  host: AgentHost;
  /** Model tiers for a task (Phase 3). Absent = code only. */
  intelligence?: (settings: Settings) => Intelligence;
  logger: Logger;
  /** Tamper-evident persistent audit log shared by all tasks. */
  audit?: PersistentAuditLog;
  newTaskId?: () => string;
}): () => void {
  const newTaskId = deps.newTaskId ?? (() => `task-${crypto.randomUUID()}`);
  let running = false;
  /** Pause / stop flags of the running task, read by the runner between steps. */
  let control = { pause: false, stop: false };

  return deps.adapter.onConnect(TASK_PORT, (port: Port) => {
    const post = (message: TaskPortMessage) => {
      try {
        port.post(message);
      } catch {
        // Page closed; the task still finishes and is saved to history.
      }
    };

    if (!deps.adapter.isOwnExtensionPage(port.sender ?? {})) {
      deps.logger.event('ACTION_BLOCKED', 'rejected task connection from untrusted sender', {
        level: 'warn',
        data: { senderUrl: port.sender?.url ?? null },
      });
      post({ type: 'TASK_ERROR', code: 'UNTRUSTED_SENDER', message: 'Not a Techie Mind page.' });
      port.disconnect();
      return;
    }

    port.onMessage((raw) => {
      const request = TaskPortRequest.safeParse(raw);
      if (!request.success) {
        post({
          type: 'TASK_ERROR',
          code: 'INVALID_MESSAGE',
          message: 'Message does not match the task contract.',
        });
        return;
      }
      const data = request.data;
      if (data.type === 'KEEPALIVE') return;
      if (data.type === 'CONTROL_TASK') {
        // Only while a task runs; it takes effect before the next step.
        if (running) control[data.action] = true;
        return;
      }
      if (data.type === 'RESUME_TASK' && data.decision === 'discard') {
        void dropCheckpoint(deps.adapter, data.taskId);
        return;
      }
      if (running) {
        post({ type: 'TASK_ERROR', code: 'BUSY', message: 'A task is already running.' });
        return;
      }
      running = true;
      control = { pause: false, stop: false };
      const job =
        data.type === 'RUN_TASK'
          ? execute(data, post)
          : resume(data.taskId, data.decision === 'approve' ? 'approve' : 'continue', post);
      // Finish all bookkeeping and release the lock BEFORE announcing the outcome, so a client
      // that starts the next task as soon as it hears the result is never told "busy".
      void job.then(
        (result) => {
          running = false;
          post({ type: 'TASK_RESULT', result });
        },
        (error: unknown) => {
          running = false;
          post({
            type: 'TASK_ERROR',
            code: 'INTERNAL',
            message: error instanceof Error ? error.message.slice(0, 500) : 'task failed',
          });
        },
      );
    });
  });

  function taskLogger(settings: Settings, post: (message: TaskPortMessage) => void): Logger {
    const streamSink: LogSink = {
      write: (event: AuditEvent) => post({ type: 'TASK_EVENT', event }),
    };
    return createLogger({
      component: 'agent',
      sinks: [streamSink, new MemorySink(200), ...(deps.audit ? [deps.audit] : [])],
      level: settings.advanced.logLevel,
      // Privacy engine redaction: page-derived PII never reaches the timeline, audit or console.
      redact: redactForLog,
    });
  }

  /** Continue a task that stopped for the human (spec §25), from its saved checkpoint. */
  async function resume(
    taskId: string,
    decision: 'continue' | 'approve',
    post: (message: TaskPortMessage) => void,
  ): Promise<TaskResult> {
    const checkpoint = await takeCheckpoint(deps.adapter, taskId);
    if (!checkpoint) {
      throw new Error('That paused task is no longer available (it expired or was already continued).');
    }
    const settings = await loadSettings(deps.adapter);
    const logger = taskLogger(settings, post);
    const skills = await loadSkills(deps.adapter);
    const result = await resumeTask(
      checkpoint,
      decision,
      {
        host: deps.host,
        logger,
        settings,
        ...(deps.intelligence ? { intelligence: deps.intelligence(settings) } : {}),
        skillInstructions: skills.instructions,
        control,
        onCheckpoint: (cp) => void saveCheckpoint(deps.adapter, cp),
      },
      newTaskId(),
    );
    await deps.audit?.flush();
    await appendHistory(deps.adapter, redactResult(result));
    return result;
  }

  async function execute(
    request: Extract<TaskPortRequest, { type: 'RUN_TASK' }>,
    post: (message: TaskPortMessage) => void,
  ): Promise<TaskResult> {
    const settings = await loadSettings(deps.adapter);
    const logger = taskLogger(settings, post);
    const skills = await loadSkills(deps.adapter);
    const runOne = async (text: string): Promise<TaskResult> => {
      const task = Task.parse({
        taskId: newTaskId(),
        text,
        source: request.source,
        mode: request.mode,
        autonomy: settings.agent.autonomy,
        language: 'unknown',
        status: 'RUNNING',
        createdAt: Date.now(),
        maxSteps: settings.agent.maxSteps,
        skillId: null,
      });
      const result = await runTask(task, {
        host: deps.host,
        logger,
        settings,
        ...(deps.intelligence ? { intelligence: deps.intelligence(settings) } : {}),
        skillInstructions: skills.instructions,
        control,
        onCheckpoint: (cp) => void saveCheckpoint(deps.adapter, cp),
      });
      await deps.audit?.flush();
      await appendHistory(deps.adapter, redactResult(result));
      return result;
    };

    // One of the user's own skills (Settings → Skills): its steps run in order, each exactly as if
    // it had been typed — same firewall, same verification, same handovers. The first step that
    // does not complete ends the skill and is what the user sees.
    const custom = matchCustomSkill(request.text, skills.custom);
    if (!custom) return runOne(request.text);
    let last: TaskResult | null = null;
    for (const [i, step] of custom.steps.entries()) {
      logger.event(
        'SYSTEM',
        `Skill "${custom.skill.name}" — step ${i + 1}/${custom.steps.length}: ${step}`,
        {
          data: { skill: custom.skill.id, step: i + 1, of: custom.steps.length },
        },
      );
      last = await runOne(step);
      if (last.status !== 'COMPLETED') {
        return TaskResult.parse({
          ...last,
          error: {
            code: last.error?.code ?? 'SKILL_STEP_FAILED',
            message:
              `Skill "${custom.skill.name}" stopped at step ${i + 1} ("${step}"): ${last.error?.message ?? last.status}`.slice(
                0,
                500,
              ),
          },
        });
      }
    }
    return last!;
  }
}

async function loadSettings(adapter: BrowserAdapter): Promise<Settings> {
  const parsed = parseSettings(await adapter.storageGet(SETTINGS_STORAGE_KEY));
  if (!parsed.ok) throw new Error('Stored settings are invalid; fix them in Settings.');
  return parsed.value;
}

/**
 * History keeps what the user needs (their own request, statuses, timings) but no page-derived
 * personal data: URLs lose query strings, page-derived texts are redacted.
 */
export function redactResult(result: TaskResult): TaskResult {
  return TaskResult.parse({
    ...result,
    finalUrl: result.finalUrl ? safeUrl(result.finalUrl) || null : null,
    target: result.target
      ? { ...result.target, url: safeUrl(result.target.url) || result.target.url }
      : null,
    steps: result.steps.map((s) => ({
      ...s,
      evidence: redactForLog(s.evidence),
      target: s.target ? redactForLog(s.target) : null,
    })),
    error: result.error ? { ...result.error, message: redactForLog(result.error.message) } : null,
    navigation: result.navigation
      ? { ...result.navigation, reason: redactForLog(result.navigation.reason) }
      : null,
    output: redactOutput(result.output),
  });
}

/** Page-derived output (titles, summaries) is redacted; URLs keep origin + path only. */
function redactOutput(output: TaskResult['output']): TaskResult['output'] {
  if (!output) return null;
  switch (output.kind) {
    case 'text':
      return { ...output, title: redactForLog(output.title), text: redactForLog(output.text) };
    case 'list':
      return {
        ...output,
        title: redactForLog(output.title),
        entries: output.entries.map(redactForLog),
      };
    case 'items':
      return {
        ...output,
        title: redactForLog(output.title),
        items: output.items.map((i) => ({
          ...i,
          title: redactForLog(i.title),
          url: i.url ? safeUrl(i.url) || null : null,
        })),
      };
  }
}

export async function readHistory(adapter: BrowserAdapter): Promise<TaskResult[]> {
  const stored = await adapter.storageGet(HISTORY_STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item) => {
    const parsed = TaskResult.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

async function appendHistory(adapter: BrowserAdapter, result: TaskResult): Promise<void> {
  const history = await readHistory(adapter);
  await adapter.storageSet(HISTORY_STORAGE_KEY, [result, ...history].slice(0, HISTORY_LIMIT));
}

// ── checkpoints of tasks waiting for the human ─────────────────────────────────────────────────

/**
 * Stored (not memory-only) because the MV3 service worker may be stopped while the user enters an
 * OTP or solves a CAPTCHA. Step texts are redacted like history; no page values are kept.
 */
export const CHECKPOINTS_STORAGE_KEY = 'techieMind.checkpoints';
const MAX_CHECKPOINTS = 5;

async function readCheckpoints(adapter: BrowserAdapter): Promise<TaskCheckpoint[]> {
  const stored = await adapter.storageGet(CHECKPOINTS_STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  const now = Date.now();
  return (stored as TaskCheckpoint[]).filter(
    (c) => c && typeof c === 'object' && typeof c.expiresAt === 'number' && c.expiresAt > now,
  );
}

async function saveCheckpoint(adapter: BrowserAdapter, checkpoint: TaskCheckpoint): Promise<void> {
  const safe: TaskCheckpoint = {
    ...checkpoint,
    steps: checkpoint.steps.map((s) => ({
      ...s,
      evidence: redactForLog(s.evidence),
      target: s.target ? redactForLog(s.target) : null,
    })),
  };
  const others = (await readCheckpoints(adapter)).filter(
    (c) => c.task.taskId !== checkpoint.task.taskId,
  );
  await adapter.storageSet(CHECKPOINTS_STORAGE_KEY, [safe, ...others].slice(0, MAX_CHECKPOINTS));
}

/** A checkpoint is used once: taking it removes it. */
async function takeCheckpoint(
  adapter: BrowserAdapter,
  taskId: string,
): Promise<TaskCheckpoint | null> {
  const all = await readCheckpoints(adapter);
  const found = all.find((c) => c.task.taskId === taskId) ?? null;
  await adapter.storageSet(
    CHECKPOINTS_STORAGE_KEY,
    all.filter((c) => c.task.taskId !== taskId),
  );
  return found;
}

async function dropCheckpoint(adapter: BrowserAdapter, taskId: string): Promise<void> {
  await takeCheckpoint(adapter, taskId);
}
