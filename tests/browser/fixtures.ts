import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { serveFixtureSites } from './sites.js';

export const EXTENSION_DIR = resolve(import.meta.dirname, '../../apps/extension/dist/chrome');

/** Loopback model endpoints: Ollama (11434) and the Laya adapter (8765). */
export const MODEL_ENDPOINTS = /^http:\/\/(?:127\.0\.0\.1|localhost):(?:11434|8765)\//;

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
      // Optional override for machines whose pinned Playwright browser is not installed.
      ...(process.env['TM_CHROMIUM'] ? { executablePath: process.env['TM_CHROMIUM'] } : {}),
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
    // Local model endpoints (Ollama, Laya adapter) are "not running" unless a test installs
    // stand-ins — so fixture tests never depend on a model that happens to run on the machine.
    await context.route(MODEL_ENDPOINTS, (route) => route.abort('connectionrefused'));
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
