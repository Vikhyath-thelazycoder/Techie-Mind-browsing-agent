import {
  TASK_PORT,
  TaskPortMessage,
  type AuditEvent,
  type TaskResult,
} from '@techie-mind/contracts';
import type { BrowserContext, Page } from '@playwright/test';

export interface AgentRun {
  result: TaskResult;
  events: AuditEvent[];
  wallMs: number;
}

const drivers = new WeakMap<BrowserContext, Page>();

/** An extension page used as the task client — exactly how the side panel talks to the agent. */
export async function driverPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const existing = drivers.get(context);
  if (existing && !existing.isClosed()) return existing;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  drivers.set(context, page);
  return page;
}

/** Run one natural-language task through the real extension and collect its event stream. */
export async function runAgentTask(
  context: BrowserContext,
  extensionId: string,
  text: string,
): Promise<AgentRun> {
  const driver = await driverPage(context, extensionId);
  const started = Date.now();
  const raw = await driver.evaluate(
    ({ text, portName }) =>
      new Promise<{ final: unknown; events: unknown[] }>((resolve) => {
        const port = chrome.runtime.connect({ name: portName });
        const events: unknown[] = [];
        const keepAlive = setInterval(() => port.postMessage({ type: 'KEEPALIVE' }), 10_000);
        port.onMessage.addListener((m: { type: string; event?: unknown }) => {
          if (m.type === 'TASK_EVENT') {
            events.push(m.event);
            return;
          }
          clearInterval(keepAlive);
          port.disconnect();
          resolve({ final: m, events });
        });
        port.postMessage({ type: 'RUN_TASK', text, mode: 'search', source: 'typed' });
      }),
    { text, portName: TASK_PORT },
  );
  const final = TaskPortMessage.parse(raw.final);
  if (final.type !== 'TASK_RESULT')
    throw new Error(`agent refused the task: ${JSON.stringify(final)}`);
  const events = raw.events
    .map((e) => TaskPortMessage.parse({ type: 'TASK_EVENT', event: e }))
    .flatMap((m) => (m.type === 'TASK_EVENT' ? [m.event] : []));
  return { result: final.result, events, wallMs: Date.now() - started };
}

/** The tab the agent worked in, found independently of the agent's own report. */
export function agentPage(context: BrowserContext, origin: string): Page {
  const page = context.pages().find((p) => p.url().startsWith(origin));
  if (!page)
    throw new Error(
      `no tab on ${origin}; open tabs: ${context
        .pages()
        .map((p) => p.url())
        .join(', ')}`,
    );
  return page;
}

export function recoveryOf(result: TaskResult, goal: 'navigate' | 'search' | 'open-result') {
  return result.steps.find((s) => s.goal === goal)?.recovery ?? [];
}

/** Compact failure text for assertion messages. */
export function explain(run: AgentRun): string {
  return [
    `status=${run.result.status} error=${run.result.error?.message ?? '-'}`,
    ...run.result.steps.map((s) => `  ${s.goal}: verified=${s.verified} ${s.evidence}`),
    ...run.events.slice(-12).map((e) => `  [${e.type}] ${e.message}`),
  ].join('\n');
}
