import { runTask, type AgentHost } from '@techie-mind/agent-core';
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
      if (request.data.type === 'KEEPALIVE') return;
      if (running) {
        post({ type: 'TASK_ERROR', code: 'BUSY', message: 'A task is already running.' });
        return;
      }
      running = true;
      // Finish all bookkeeping and release the lock BEFORE announcing the outcome, so a client
      // that starts the next task as soon as it hears the result is never told "busy".
      void execute(request.data, post).then(
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

  async function execute(
    request: Extract<TaskPortRequest, { type: 'RUN_TASK' }>,
    post: (message: TaskPortMessage) => void,
  ): Promise<TaskResult> {
    const settings = await loadSettings(deps.adapter);
    const streamSink: LogSink = {
      write: (event: AuditEvent) => post({ type: 'TASK_EVENT', event }),
    };
    const logger = createLogger({
      component: 'agent',
      sinks: [streamSink, new MemorySink(200), ...(deps.audit ? [deps.audit] : [])],
      level: settings.advanced.logLevel,
      // Privacy engine redaction: page-derived PII never reaches the timeline, audit or console.
      redact: redactForLog,
    });
    const task = Task.parse({
      taskId: newTaskId(),
      text: request.text,
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
    });
    await deps.audit?.flush();
    await appendHistory(deps.adapter, redactResult(result));
    return result;
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
