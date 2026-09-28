import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { serveFixtureSites } from './sites.js';

export const EXTENSION_DIR = resolve(import.meta.dirname, '../../apps/extension/dist/chrome');

/** A fixture origin served by Playwright routing — no real network, fully deterministic. */
export const FIXTURE_ORIGIN = 'https://fixture.techiemind.test';

export const FIXTURE_HTML = `<!doctype html><html><head><title>Fixture</title></head>
<body><h1>Fixture page</h1><input type="search" aria-label="Search"></body></html>`;

type Fixtures = {
  /** Extra Chromium switches for a test file (e.g. a profile that permits autoplay). */
  browserArgs: string[];
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
};

export const test = base.extend<Fixtures>({
  browserArgs: [[], { option: true }],
  context: async ({ browserArgs }, use) => {
    if (!existsSync(resolve(EXTENSION_DIR, 'manifest.json'))) {
      throw new Error(`Extension not built at ${EXTENSION_DIR} — run \`npm run build\` first.`);
    }
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
        ...browserArgs,
      ],
    });
    await context.route(`${FIXTURE_ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE_HTML }),
    );
    await serveFixtureSites(context);
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const [existing] = context.serviceWorkers();
    const worker = existing ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export const expect = test.expect;
