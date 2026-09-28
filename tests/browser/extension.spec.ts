import { ContentPong, HealthResponse } from '@techie-mind/contracts';
import { expect, FIXTURE_ORIGIN, test } from './fixtures.js';

test.describe('Chrome MV3 extension — real browser', () => {
  test('service worker starts from the built bundle', async ({ serviceWorker, extensionId }) => {
    expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  });

  test('toolbar button is bound to the side panel', async ({ serviceWorker }) => {
    const behavior = await serviceWorker.evaluate(() => chrome.sidePanel.getPanelBehavior());
    expect(behavior.openPanelOnActionClick).toBe(true);
  });

  test('background answers a schema-valid health request and rejects malformed ones', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    const health = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'HEALTH_REQUEST' }),
    );
    const parsed = HealthResponse.parse(health);
    expect(parsed.browser).toBe('chrome');
    expect(parsed.version).toBe('0.1.0');

    const rejected = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'RUN_SCRIPT', code: 'alert(1)' }),
    );
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
  });

  test('content script is absent from ordinary pages and injected on demand with a stable document identity', async ({
    context,
    serviceWorker,
  }) => {
    const page = await context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/`);
    await page.waitForLoadState('load');

    const ping = () =>
      serviceWorker.evaluate(async (origin) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url?.startsWith(origin));
        if (tab?.id === undefined) throw new Error('fixture tab not found');
        return chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_PING' });
      }, FIXTURE_ORIGIN);
    const inject = () =>
      serviceWorker.evaluate(async (origin) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url?.startsWith(origin));
        if (tab?.id === undefined) throw new Error('fixture tab not found');
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }, FIXTURE_ORIGIN);

    // Zero footprint in ordinary browsing: nothing is listening in this page.
    await expect(ping()).rejects.toThrow(
      /Receiving end does not exist|Could not establish connection/,
    );

    await inject();
    const first = ContentPong.parse(await ping());
    expect(first.origin).toBe(FIXTURE_ORIGIN);
    expect(first.readyState).toBe('complete');
    expect(first.documentId).toMatch(/^doc-/);

    // Re-injection into the same document is a no-op: same identity.
    await inject();
    expect(ContentPong.parse(await ping()).documentId).toBe(first.documentId);
    // A new document gets a new identity (observation binding basis) — and needs a new injection.
    await page.reload();
    await page.waitForLoadState('load');
    await inject();
    expect(ContentPong.parse(await ping()).documentId).not.toBe(first.documentId);
  });

  test('side panel renders the Techie Mind shell', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);

    await expect(page.locator('.tm-brand-name')).toHaveText('Techie Mind');
    await expect(page.getByRole('heading', { name: 'What are we doing today?' })).toBeVisible();
    await expect(page.locator('.tm-action-card')).toHaveCount(5);
    await expect(page.getByTestId('model-chip')).toContainText('qwen2.5:7b');
    await expect(page.getByTestId('privacy-pill')).toContainText('ON');
    // Send is live but disabled while the task box is empty.
    await expect(page.getByTestId('send')).toBeDisabled();
    await page.getByTestId('task-input').fill('Open YouTube');
    await expect(page.getByTestId('send')).toBeEnabled();
    await page.getByTestId('task-input').fill('');
    await page.screenshot({ path: 'evidence/sidepanel-agent-420.png' });
    await page.setViewportSize({ width: 530, height: 1000 });
    await page.screenshot({ path: 'evidence/sidepanel-agent-530.png' });

    await page.getByTestId('quick-summaries').click();
    await expect(page.getByTestId('agent-notice')).toContainText('Phase 6');

    await page.getByTestId('tab-history').click();
    await expect(page.getByTestId('history-view')).toBeVisible();
    await page.screenshot({ path: 'evidence/sidepanel-history.png' });

    await page.getByTestId('tab-privacy').click();
    await expect(page.getByTestId('privacy-view')).toContainText('Privacy boundary');
    await page.screenshot({ path: 'evidence/sidepanel-privacy.png' });
  });

  test('settings persist, validate, and propagate live to the side panel', async ({
    context,
    extensionId,
  }) => {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await expect(panel.getByTestId('privacy-pill')).toContainText('ON');

    const settings = await context.newPage();
    await settings.setViewportSize({ width: 1400, height: 900 });
    await settings.goto(`chrome-extension://${extensionId}/settings/index.html`);
    await settings.screenshot({ path: 'evidence/settings-models.png' });

    // Valid change: turn the privacy boundary off and save.
    await settings.getByTestId('nav-privacy').click();
    await settings.getByTestId('privacy-enabled').uncheck();
    await settings.getByTestId('save-settings').click();
    await expect(settings.getByTestId('save-status')).toHaveText('Saved');
    await expect(panel.getByTestId('privacy-pill')).toContainText('OFF');

    // Survives a reload (persisted in chrome.storage.local).
    await settings.reload();
    await settings.getByTestId('nav-privacy').click();
    await expect(settings.getByTestId('privacy-enabled')).not.toBeChecked();

    // Invalid change is refused and nothing is written.
    await settings.getByTestId('nav-export').click();
    await settings.getByTestId('export-folder').fill('../../etc');
    await settings.getByTestId('save-settings').click();
    await expect(settings.getByTestId('save-status')).toContainText('Not saved');
    const stored = await settings.evaluate(async () => {
      const items = await chrome.storage.local.get('techieMind.settings');
      return (items['techieMind.settings'] as { export: { folder: string } }).export.folder;
    });
    expect(stored).toBe('TechieMind');
  });

  test('model selection is one authority shared by settings and the side panel', async ({
    context,
    extensionId,
  }) => {
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings/index.html#models`);
    await settings.getByRole('tab', { name: 'Compatible (OpenAI Compatible)' }).click();
    await settings.locator('#gw-endpoint').fill('https://gateway.example.com/v1');
    await settings.locator('#gw-model').fill('gpt-4o-mini');
    await settings.getByRole('radio', { name: 'Use the gateway as the active model' }).check();
    await settings.getByTestId('save-settings').click();
    await expect(settings.getByTestId('save-status')).toHaveText('Saved');
    await expect(settings.getByTestId('active-model')).toContainText('gpt-4o-mini');

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await expect(panel.getByTestId('model-chip')).toContainText('gpt-4o-mini');

    // Switch back to local from the side panel: settings page follows.
    await panel.getByTestId('model-chip').click();
    await panel.getByRole('menuitemradio', { name: /Local Model/ }).click();
    await expect(panel.getByTestId('model-chip')).toContainText('qwen2.5:7b');
    await settings.reload();
    await expect(settings.getByTestId('active-model')).toContainText('qwen2.5:7b');
  });

  test('diagnostics system test round-trips through the service worker', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/settings/index.html#diagnostics`);
    await page.getByTestId('run-system-test').click();
    await expect(page.getByTestId('system-test-result')).toContainText('PASS');
    await page.screenshot({ path: 'evidence/settings-diagnostics.png' });
  });
});
