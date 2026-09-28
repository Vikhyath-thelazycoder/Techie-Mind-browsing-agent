import { defineConfig } from '@playwright/test';
import { LIVE_BROWSER_ARGS } from './tests/live/live-helpers.js';

/**
 * Real-browser tests. They load the BUILT extension (apps/extension/dist/chrome) into Chromium,
 * so run `npm run build` first. Extensions require a persistent context; see tests/browser/fixtures.ts.
 *
 * Projects:
 *   browser — deterministic: extension shell + agent on local fixture sites (no network)
 *   live    — acceptance on real websites (needs internet; sites can change or block automation)
 */
export default defineConfig<{ browserArgs: string[] }>({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  projects: [
    { name: 'browser', testDir: 'tests/browser' },
    {
      name: 'live',
      testDir: 'tests/live',
      timeout: 180_000,
      use: { browserArgs: LIVE_BROWSER_ARGS },
    },
  ],
});
