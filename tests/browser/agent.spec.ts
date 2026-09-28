import { agentPage, explain, recoveryOf, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';

/**
 * Real-Chromium agent tests on local fixture sites. The agent receives only the natural-language
 * request; every assertion checks the resulting page independently of the agent's own report.
 */
test.describe.configure({ timeout: 120_000 });

test.describe('agent core — real browser, local fixture sites', () => {
  test('classic form search: navigate, ground, type, submit, verify', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'Open form.fixture.test and search for trail running shoes',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    const page = agentPage(context, 'https://form.fixture.test');
    expect(new URL(page.url()).pathname).toBe('/search');
    expect(new URL(page.url()).searchParams.get('q')).toBe('trail running shoes');
    await expect(page.getByRole('searchbox', { name: 'Search catalogue' })).toHaveValue(
      'trail running shoes',
    );
    await expect(page.locator('a.result', { hasText: 'trail running shoes' })).toHaveCount(3);
    // The newsletter decoy was never touched.
    await expect(page.locator('input[type=email]')).toHaveValue('');
    expect(run.result.timings.modelCalls).toBe(0);
  });

  test('same site, different wording and query — no code change', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'go to form.fixture.test and look up waterproof hiking boots',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(
      new URL(agentPage(context, 'https://form.fixture.test').url()).searchParams.get('q'),
    ).toBe('waterproof hiking boots');
  });

  test('script-driven search with no form, behind a login overlay', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'search spa.fixture.test for bluetooth headphones',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    const page = agentPage(context, 'https://spa.fixture.test');
    expect(page.url()).toBe('https://spa.fixture.test/s?query=bluetooth%20headphones');
    await expect(
      page.getByRole('heading', { name: 'Showing results for bluetooth headphones' }),
    ).toBeVisible();
    await expect(page.locator('input[type=tel]')).toHaveValue('');
  });

  test('collapsed search is revealed through its toggle (recovery L5)', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'open toggle.fixture.test and search for linen shirts',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(recoveryOf(run.result, 'search').map((r) => r.strategy)).toContain(
      'alternative-strategy',
    );
    expect(
      new URL(agentPage(context, 'https://toggle.fixture.test').url()).searchParams.get('q'),
    ).toBe('linen shirts');
  });

  test('field re-mounted under the agent is re-grounded (recovery L3)', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'open remount.fixture.test and search for ceramic mugs',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(recoveryOf(run.result, 'search').map((r) => r.strategy)).toContain('reground');
    expect(
      new URL(agentPage(context, 'https://remount.fixture.test').url()).searchParams.get('q'),
    ).toBe('ceramic mugs');
  });

  test('Enter does nothing: falls back to the search button (recovery L5)', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'open button.fixture.test and search for space exploration books',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(recoveryOf(run.result, 'search').map((r) => [r.level, r.strategy])).toContainEqual([
      5,
      'alternative-strategy',
    ]);
    expect(
      new URL(agentPage(context, 'https://button.fixture.test').url()).searchParams.get('term'),
    ).toBe('space exploration books');
  });

  test('play request: search, open the best result, verify media is playing', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'go to video.fixture.test and play lo-fi beats',
    );
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(run.result.steps.map((s) => s.goal)).toEqual(['navigate', 'search', 'open-result']);
    const page = agentPage(context, 'https://video.fixture.test');
    expect(new URL(page.url()).pathname).toBe('/watch');
    expect(
      await page.locator('video').evaluate((m: HTMLMediaElement) => !m.paused && m.currentTime > 0),
    ).toBe(true);
  });

  test('page without search: honest handover, never a fake success', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(
      context,
      extensionId,
      'open plain.fixture.test and search for anything useful',
    );
    expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
    expect(run.events.map((e) => e.type)).not.toContain('TASK_COMPLETED');
    expect(run.events.map((e) => e.type)).toContain('HANDOVER_REQUIRED');
    expect(recoveryOf(run.result, 'search').at(-1)).toMatchObject({
      level: 6,
      strategy: 'handover',
    });
  });

  test('side panel UI: plan preview, run, live timeline, result and history', async ({
    context,
    extensionId,
  }) => {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await expect(panel.getByTestId('send')).toBeDisabled();
    await panel.getByTestId('task-input').fill('Open form.fixture.test and search for garden hose');
    await panel.getByTestId('task-input').press('Enter');
    // Default autonomy is "Ask before acting": the plan is shown first.
    await expect(panel.getByTestId('plan-card')).toContainText('Search for "garden hose"');
    await panel.getByTestId('plan-run').click();
    await expect(panel.getByTestId('result-card')).toHaveAttribute('data-status', 'COMPLETED', {
      timeout: 60_000,
    });
    // Where the agent acted, and why (navigation policy).
    await expect(panel.getByTestId('result-navigation')).toContainText(
      'Opened directly — the user named form.fixture.test',
    );
    await expect(panel.getByTestId('result-privacy')).toContainText('0 sent externally');
    for (const type of [
      'INTENT_RESOLVED',
      'TARGET_GROUNDED',
      'ACTION_EXECUTED',
      'VERIFICATION_COMPLETED',
    ]) {
      await expect(panel.locator(`[data-type=${type}]`).first()).toBeVisible();
    }
    await panel.screenshot({
      path: 'evidence/phase1-sidepanel-run.png',
      fullPage: true,
    });
    await panel.getByTestId('tab-history').click();
    await expect(panel.getByTestId('history-item').first()).toContainText('garden hose');
    await panel.screenshot({
      path: 'evidence/phase1-sidepanel-history.png',
      fullPage: true,
    });
  });
});
