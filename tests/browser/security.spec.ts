import { bindAction } from '@techie-mind/agent-core';
import {
  ExecuteResponse,
  ObserveResponse,
  TASK_PORT,
  type Action,
  type Observation,
} from '@techie-mind/contracts';
import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * Phase 1 security regressions in real Chromium: the content script (the last gate before the
 * page) must refuse unbound, mismatched, stale, unsupported and malformed actions — with a
 * positive control proving the same path executes a valid action.
 */
const ORIGIN = 'https://form.fixture.test';

async function tabId(sw: Worker): Promise<number> {
  return sw.evaluate(async (origin) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin));
    if (tab?.id === undefined) throw new Error('fixture tab not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return tab.id;
  }, ORIGIN);
}

const send = (sw: Worker, id: number, message: unknown) =>
  sw.evaluate(([tab, msg]) => chrome.tabs.sendMessage(tab as number, msg), [id, message] as const);

function typeAction(
  obs: Observation,
  tab: number,
  targetId: string,
  overrides: (a: Action) => Action = (a) => a,
): Action {
  const target = obs.domNodes.find((n) => n.nodeId === targetId)!;
  return overrides(
    bindAction({
      actionId: `act-${Math.random().toString(36).slice(2)}`,
      taskId: 'task-sec',
      tabId: tab,
      observation: obs,
      target,
      args: { type: 'TYPE', input: { text: 'boots' }, submit: false },
      reason: 'security test',
      confidence: 1,
      expectedOutcome: { kind: 'field-value', description: '' },
      proposedBy: 'deterministic',
      now: 0,
    }),
  );
}

test.describe('security regressions — real browser', () => {
  test('content script rejects unbound/mismatched/stale/unsupported/malformed actions', async ({
    context,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const tab = await tabId(serviceWorker);
    const obs = ObserveResponse.parse(
      await send(serviceWorker, tab, {
        type: 'OBSERVE',
        taskId: 'task-sec',
        observationId: 'obs-sec',
        tabId: tab,
      }),
    ).observation;
    const field = obs.domNodes.find((n) => n.inputType === 'search')!;
    const email = obs.domNodes.find((n) => n.inputType === 'email')!;
    const exec = async (action: unknown) => send(serviceWorker, tab, { type: 'EXECUTE', action });

    // Positive control: the same channel executes a valid, bound action.
    expect(ExecuteResponse.parse(await exec(typeAction(obs, tab, field.nodeId)))).toMatchObject({
      status: 'executed',
      valueAfter: 'boots',
    });

    const cases: Array<[string, Action, string]> = [
      [
        'other document',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          binding: { ...a.binding, documentId: 'doc-forged' },
        })),
        'DOCUMENT_MISMATCH',
      ],
      [
        'other origin',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          binding: { ...a.binding, origin: 'https://evil.fixture.test' },
        })),
        'ORIGIN_MISMATCH',
      ],
      [
        'future version',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          binding: { ...a.binding, observationVersion: 10_000 },
        })),
        'STALE_OBSERVATION',
      ],
      [
        'unknown element',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          binding: {
            ...a.binding,
            target: { kind: 'element', elementId: 'el-99999', fingerprint: null },
          },
        })),
        'TARGET_MISSING',
      ],
      [
        'swapped identity (id of one element, fingerprint of another)',
        typeAction(obs, tab, field.nodeId, (a) => {
          const other = typeAction(obs, tab, email.nodeId).binding.target;
          return {
            ...a,
            binding: {
              ...a.binding,
              target:
                other && other.kind === 'element' ? { ...other, elementId: field.nodeId } : other,
            },
          };
        }),
        'TARGET_CHANGED',
      ],
      [
        'navigation from the page',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          binding: { ...a.binding, target: null },
          args: { type: 'NAVIGATE', url: 'https://evil.fixture.test/' },
        })),
        'UNSUPPORTED_ACTION',
      ],
      [
        'vault token before Phase 2',
        typeAction(obs, tab, field.nodeId, (a) => ({
          ...a,
          args: { type: 'TYPE', input: { vaultToken: 'PHONE_001' }, submit: false },
        })),
        'UNSUPPORTED_ACTION',
      ],
    ];
    for (const [name, action, code] of cases) {
      expect(ExecuteResponse.parse(await exec(action)), name).toMatchObject({
        status: 'rejected',
        code,
      });
    }

    // Stale target: the element disappears between observation and execution.
    const stale = typeAction(obs, tab, field.nodeId);
    await page.evaluate(() => document.querySelector('input[type=search]')!.remove());
    expect(ExecuteResponse.parse(await exec(stale))).toMatchObject({
      status: 'rejected',
      code: 'TARGET_DETACHED',
    });

    // Malformed actions never reach the executor.
    const jsNav = {
      ...stale,
      binding: { ...stale.binding, target: null },
      // eslint-disable-next-line no-script-url -- hostile input under test: must be rejected
      args: { type: 'NAVIGATE', url: 'javascript:alert(1)' },
    };
    expect(await exec(jsNav)).toMatchObject({ type: 'ERROR', code: 'INVALID_MESSAGE' });
    expect(
      await exec({ ...stale, args: { type: 'EXECUTE_SCRIPT', code: 'document.cookie' } }),
    ).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(await send(serviceWorker, tab, { type: 'EVAL', code: '1+1' })).toMatchObject({
      code: 'INVALID_MESSAGE',
    });

    // The newsletter decoy was never modified by any of the above.
    await expect(page.locator('input[type=email]')).toHaveValue('');
  });

  test('web pages cannot reach the agent; the task port rejects malformed requests', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    const reachable = await page.evaluate(() => {
      const c = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome;
      return typeof c?.runtime?.connect === 'function';
    });
    expect(reachable).toBe(false);

    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const replies = await ext.evaluate(
      (portName) =>
        new Promise<unknown[]>((resolve) => {
          const port = chrome.runtime.connect({ name: portName });
          const got: unknown[] = [];
          port.onMessage.addListener((m) => {
            got.push(m);
            if (got.length === 2) resolve(got);
          });
          port.postMessage({
            type: 'RUN_TASK',
            text: 'x',
            mode: 'search',
            source: 'typed',
            script: 'alert(1)',
          });
          port.postMessage({ type: 'RUN_SCRIPT', code: 'alert(1)' });
        }),
      TASK_PORT,
    );
    expect(replies).toEqual([
      {
        type: 'TASK_ERROR',
        code: 'INVALID_MESSAGE',
        message: 'Message does not match the task contract.',
      },
      {
        type: 'TASK_ERROR',
        code: 'INVALID_MESSAGE',
        message: 'Message does not match the task contract.',
      },
    ]);
  });
});
