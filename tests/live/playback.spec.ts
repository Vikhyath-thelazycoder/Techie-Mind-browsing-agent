import { agentPage, explain, runAgentTask, type AgentRun } from '../browser/agent-helpers.js';
import { expect, test } from '../browser/fixtures.js';
import { LIVE_BROWSER_ARGS, record } from './live-helpers.js';

/**
 * Exploratory (not a Phase 1 acceptance criterion): spec §46 flagship playback on live YouTube.
 * Media state is verified independently from the page's own <video> element.
 */
const REQUEST = 'Open YouTube and play some Kannada songs';

async function mediaState(context: Parameters<typeof agentPage>[0]) {
  const page = agentPage(context, 'https://www.youtube.com');
  const media = await page
    .evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      const main = videos.sort(
        (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
      )[0];
      return main ? { paused: main.paused, currentTime: main.currentTime } : null;
    })
    .catch(() => null);
  return { page, media };
}

function save(name: string, run: AgentRun, url: string, media: unknown) {
  record({
    name,
    request: REQUEST,
    status: run.result.status,
    finalUrl: url,
    independent: { path: new URL(url).pathname, media },
    timings: run.result.timings,
    wallMs: run.wallMs,
    recovery: run.result.steps.flatMap((s) =>
      s.recovery.map((r) => `${s.goal}:L${r.level}:${r.strategy}`),
    ),
  });
}

test.describe('P1 — default Chrome autoplay policy (fresh profile)', () => {
  test('hands over with a precise instruction instead of claiming success', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, REQUEST);
    const { page, media } = await mediaState(context);
    await page.screenshot({ path: 'evidence/phase1-live-P1.png' });
    save('P1', run, page.url(), media);
    if (run.result.status === 'COMPLETED') {
      // Allowed only if playback genuinely happened.
      expect(media?.paused, explain(run)).toBe(false);
    } else {
      expect(run.result.status, explain(run)).toBe('HUMAN_REQUIRED');
      expect(run.result.error?.message).toMatch(/Press Play/);
      expect(new URL(page.url()).pathname).toBe('/watch');
    }
  });
});

test.describe('P2 — profile where autoplay is permitted', () => {
  test.use({ browserArgs: [...LIVE_BROWSER_ARGS, '--autoplay-policy=no-user-gesture-required'] });
  test('searches, opens a video and verifies sustained playback', async ({
    context,
    extensionId,
  }) => {
    const run = await runAgentTask(context, extensionId, REQUEST);
    const { page, media } = await mediaState(context);
    await page.screenshot({ path: 'evidence/phase1-live-P2.png' });
    save('P2', run, page.url(), media);
    expect(run.result.status, explain(run)).toBe('COMPLETED');
    expect(new URL(page.url()).pathname).toBe('/watch');
    expect(media?.paused).toBe(false);
  });
});
