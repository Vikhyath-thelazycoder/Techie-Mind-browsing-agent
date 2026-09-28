import { explain, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';
import { serveModelStandIns } from './model-standins.js';
import { SYNTHETIC_PII } from './sites.js';

/**
 * Phase 3 in real Chromium: the built extension routes a command code cannot pick alone through
 * Laya and the local model (stand-in servers speaking the real wire formats), the model's choice is
 * re-checked and firewall-authorized, and nothing personal is sent.
 */
test.describe.configure({ timeout: 120_000 });

test.describe('model routing — real browser', () => {
  test('"now open the buying guide one": Laya → local model → one verified click on the open site', async ({
    context,
    extensionId,
  }) => {
    const traffic = await serveModelStandIns(context, { laya: 'escalate', model: 'element' });
    const first = await runAgentTask(
      context,
      extensionId,
      'Open form.fixture.test and search for samsung phones',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    expect(first.result.models).toEqual([]); // code was sure: no model call

    const second = await runAgentTask(context, extensionId, 'now open the buying guide one');
    expect(second.result.status, `${explain(second)} ${JSON.stringify(second.result.models)}`).toBe(
      'COMPLETED',
    );
    expect(second.result.models.map((m) => [m.tier, m.outcome])).toEqual([
      ['laya', 'escalated'],
      ['qwen', 'answered'],
    ]);
    expect(second.result.intent).toMatchObject({ resolvedBy: 'qwen', action: 'open_element' });
    // resultsList #3 is "<q> buying guide and reviews" → /item/3, opened once in the same tab.
    const tab = context.pages().find((p) => p.url().startsWith('https://form.fixture.test/item/'));
    expect(new URL(tab!.url()).pathname).toBe('/item/3');
    expect(second.events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
    expect(second.events.filter((e) => e.type === 'NAVIGATION_STARTED')).toHaveLength(0);
    expect(traffic.laya).toBe(1);
    expect(traffic.chat).toBe(1);
    // What the model saw is the sanitized summary: no query string, no raw DOM, no field values.
    const sent = traffic.bodies.join('\n');
    expect(sent).not.toMatch(/search\?q=|domNodes|a11yNodes|"value"/);
  });

  test('a page full of personal data: the model is asked, nothing personal is sent, the user is asked back', async ({
    context,
    extensionId,
  }) => {
    const traffic = await serveModelStandIns(context, { laya: 'escalate', model: 'abstain' });
    const page = await context.newPage();
    await page.goto('https://profile.fixture.test/search?q=march');
    await page.bringToFront();
    const run = await runAgentTask(context, extensionId, 'open the one for 98765 43210');
    expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
    expect(run.result.error?.code).toBe('NEEDS_CLARIFICATION');
    expect(traffic.chat).toBe(1);
    const sent = traffic.bodies.join('\n');
    for (const value of Object.values(SYNTHETIC_PII)) expect(sent).not.toContain(value);
    expect(sent).toMatch(/PHONE_\d{3}/);
  });

  test('models not running: an ordinary follow-up still completes with code; nothing is guessed', async ({
    context,
    extensionId,
  }) => {
    await serveModelStandIns(context, { laya: 'down', model: 'down' });
    const first = await runAgentTask(
      context,
      extensionId,
      'Open form.fixture.test and search for lamps',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    // A plain name-like query never needs a model.
    const plain = await runAgentTask(context, extensionId, 'desk lamp');
    expect(plain.result.status, explain(plain)).toBe('COMPLETED');
    expect(plain.result.timings.modelCalls).toBe(0);
    // A longer, unsure one tries both tiers, finds them down, and completes with the code reading.
    const second = await runAgentTask(
      context,
      extensionId,
      'lamps for a small study table with warm light',
    );
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    expect(
      second.result.models.map((m) => m.outcome),
      JSON.stringify(second.result.models),
    ).toEqual(['unavailable', 'unavailable']);
    const third = await runAgentTask(context, extensionId, 'open the samsung one');
    expect(third.result.error?.code).toBe('NEEDS_CLARIFICATION');
  });
});
