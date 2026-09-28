import { explain, runAgentTask } from './agent-helpers.js';
import { expect, test } from './fixtures.js';
import { serveVisionStandIns } from './model-standins.js';

/**
 * Phase 4 in real Chromium: product tiles with no accessible names. The built extension routes
 * "open the red one" Code → Laya → text model (abstains) → level 4: captures the visible tab, paints
 * personal data over inside the background, and the vision stand-in — which decodes the PNG it
 * actually received — finds the red tile. The box is grounded to the tile's link and clicked once,
 * through the firewall.
 */
test.describe.configure({ timeout: 120_000 });

test.describe('visual fallback — real browser', () => {
  test('"open the red one" on image-only tiles: redacted capture → vision → the red tile opens', async ({
    context,
    extensionId,
  }) => {
    const traffic = await serveVisionStandIns(context);
    const first = await runAgentTask(
      context,
      extensionId,
      'Open visual.fixture.test and search for shoes',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    const results = context
      .pages()
      .find((p) => p.url().startsWith('https://visual.fixture.test/search'))!;
    await results.bringToFront();
    // Where the private data and the tiles are, in CSS pixels, before the task runs.
    const geometry = await results.evaluate(() => {
      const r = (id: string) => {
        const b = document.getElementById(id)!.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      return {
        width: innerWidth,
        email: r('pii-email'),
        phone: r('pii-phone'),
        pass: r('pii-pass'),
        red: r('tile-2'),
      };
    });

    const second = await runAgentTask(context, extensionId, 'now open the red one');
    expect(
      second.result.status,
      `${explain(second)} ${JSON.stringify(second.result.models)} ${second.events
        .filter((e) => e.type === 'SYSTEM' || e.type === 'OBSERVATION_CREATED')
        .map((e) => e.message)
        .join(' | ')}`,
    ).toBe('COMPLETED');
    expect(second.result.models.map((m) => [m.tier, m.outcome])).toEqual([
      ['laya', 'escalated'],
      ['qwen', 'abstained'],
      ['vision', 'answered'],
    ]);
    expect(second.result.intent?.resolvedBy).toBe('vision');
    const opened = context
      .pages()
      .filter((p) => p.url().startsWith('https://visual.fixture.test/item/'));
    expect(opened.map((p) => new URL(p.url()).pathname)).toEqual(['/item/2']);
    expect(second.events.some((e) => e.type === 'ACTION_ALLOWED')).toBe(true);
    expect(second.result.timings.visionMs).toBeGreaterThan(0);

    // What left the browser: exactly one redacted screenshot; private data painted black.
    expect(traffic.vision).toBe(1);
    const image = traffic.images[0]!;
    expect(image.width).toBe(1008 > geometry.width ? Math.floor(geometry.width / 28) * 28 : 1008);
    const scale = image.width / geometry.width;
    for (const spot of [geometry.email, geometry.phone, geometry.pass]) {
      const [r, g, b] = image.pixel(Math.round(spot.x * scale), Math.round(spot.y * scale));
      expect([r, g, b], `private data at ${JSON.stringify(spot)} must be painted over`).toEqual([
        0, 0, 0,
      ]);
    }
    // Control: the red tile itself was not painted over (the model could see it).
    const [r, g, b] = image.pixel(
      Math.round(geometry.red.x * scale),
      Math.round(geometry.red.y * scale),
    );
    expect(r).toBeGreaterThan(180);
    expect(g + b).toBeLessThan(140);
    // No text leaves either: the request text and page summary carry no personal data.
    const sent = traffic.bodies.join('\n');
    expect(sent).not.toMatch(/asha\.verma@example\.com|98765 43210|hunter2/);
    const privacyLine = second.events.find((e) =>
      e.message.startsWith('Screenshot redacted locally'),
    );
    expect(privacyLine?.data['regions']).toBeGreaterThanOrEqual(3);
  });

  test('a page the agent can read makes no capture at all', async ({ context, extensionId }) => {
    const traffic = await serveVisionStandIns(context);
    const first = await runAgentTask(
      context,
      extensionId,
      'Open form.fixture.test and search for lamps',
    );
    expect(first.result.status, explain(first)).toBe('COMPLETED');
    const second = await runAgentTask(context, extensionId, 'open the second result');
    expect(second.result.status, explain(second)).toBe('COMPLETED');
    expect(second.result.timings.visionMs).toBe(0);
    expect(traffic.vision).toBe(0);
    expect(traffic.laya + traffic.chat).toBe(0);
  });
});
