import { createAdapter, type WebExtensionApi } from '@techie-mind/browser';
import { HealthResponse } from '@techie-mind/contracts';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { createBackgroundHandler } from '../src/background/handler.js';

const noopEvent = { addListener: () => {}, removeListener: () => {} };

function adapterWith(openOptionsPage = vi.fn(async () => {})) {
  const api = {
    runtime: {
      id: 'ext-id',
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async () => undefined,
      openOptionsPage,
      onMessage: noopEvent,
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: noopEvent },
    tabs: { query: async () => [], sendMessage: async () => undefined, create: async () => ({}) },
  } as unknown as WebExtensionApi;
  return createAdapter('chrome', api);
}

const PAGE = { id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel/index.html' };

describe('background handler', () => {
  function setup() {
    const sink = new MemorySink();
    const openOptionsPage = vi.fn(async () => {});
    const handler = createBackgroundHandler({
      adapter: adapterWith(openOptionsPage),
      logger: createLogger({ component: 'bg', sinks: [sink] }),
      startedAt: 1_000,
      now: () => 1_250,
    });
    return { handler, sink, openOptionsPage };
  }

  it('answers a health request from its own page with a contract-valid response', async () => {
    const { handler } = setup();
    const reply = await handler({ type: 'HEALTH_REQUEST' }, PAGE);
    expect(HealthResponse.parse(reply)).toMatchObject({ browser: 'chrome', uptimeMs: 250 });
  });

  it('rejects requests from web pages / content scripts and logs the block', async () => {
    const { handler, sink } = setup();
    const reply = await handler(
      { type: 'HEALTH_REQUEST' },
      { id: 'ext-id', url: 'https://evil.test/', tab: { id: 3 } },
    );
    expect(reply).toMatchObject({ ok: false, code: 'UNTRUSTED_SENDER' });
    expect(sink.events.at(-1)?.type).toBe('ACTION_BLOCKED');
  });

  it('rejects requests from other extensions', async () => {
    const { handler } = setup();
    const reply = await handler(
      { type: 'HEALTH_REQUEST' },
      { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' },
    );
    expect(reply).toMatchObject({ ok: false, code: 'UNTRUSTED_SENDER' });
  });

  it('rejects malformed or unknown messages', async () => {
    const { handler } = setup();
    expect(await handler({ type: 'RUN_JS', code: 'alert(1)' }, PAGE)).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    expect(await handler({ type: 'HEALTH_REQUEST', extra: true }, PAGE)).toMatchObject({
      code: 'INVALID_MESSAGE',
    });
  });

  it('opens the settings page on request', async () => {
    const { handler, openOptionsPage } = setup();
    expect(await handler({ type: 'OPEN_SETTINGS' }, PAGE)).toEqual({ type: 'OK', ok: true });
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
