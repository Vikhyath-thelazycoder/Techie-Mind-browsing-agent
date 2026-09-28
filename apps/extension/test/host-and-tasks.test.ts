import type { AgentHost } from '@techie-mind/agent-core';
import {
  createAdapter,
  type BrowserAdapter,
  type RawPort,
  type WebExtensionApi,
} from '@techie-mind/browser';
import { Action, TASK_PORT } from '@techie-mind/contracts';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionHost, probeWebsite } from '../src/background/host.js';
import { startTaskService } from '../src/background/tasks.js';

function ev<L>() {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: (l: L) => void listeners.add(l),
    removeListener: (l: L) => void listeners.delete(l),
  };
}

function api() {
  const onConnect = ev<(p: RawPort) => void>();
  const sendMessage = vi.fn(async () => ({}));
  const store: Record<string, unknown> = {};
  const raw = {
    runtime: {
      id: 'ext-id',
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: vi.fn(),
      openOptionsPage: vi.fn(),
      onMessage: ev(),
      connect: vi.fn(),
      onConnect,
    },
    storage: {
      local: {
        get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
        set: async (items: Record<string, unknown>) => void Object.assign(store, items),
      },
      onChanged: ev(),
    },
    tabs: {
      query: async () => [],
      get: async () => ({}),
      sendMessage,
      create: async () => ({}),
      update: async () => ({}),
      goBack: async () => {},
      captureTab: async () => null,
    },
  } as unknown as WebExtensionApi;
  return { raw, onConnect, sendMessage, store };
}

describe('ExtensionHost', () => {
  it('refuses to execute an action bound to a different tab (cross-tab safety)', async () => {
    const { raw, sendMessage } = api();
    const host = new ExtensionHost(createAdapter('chrome', raw));
    const action = Action.parse({
      actionId: 'a',
      binding: {
        taskId: 't',
        observationId: 'o',
        documentId: 'd',
        tabId: 9,
        origin: 'https://x.test',
        target: { kind: 'element', elementId: 'el-1', fingerprint: null },
        observationVersion: 0,
      },
      args: { type: 'CLICK' },
      reason: '',
      confidence: 1,
      expectedOutcome: { kind: 'none', description: '' },
      proposedBy: 'deterministic',
      createdAt: 0,
    });
    const result = await host.execute(3, action);
    expect(result).toMatchObject({ status: 'rejected', code: 'DOCUMENT_MISMATCH' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function port(senderUrl: string) {
  const onMessage = ev<(m: unknown) => void>();
  const posted: unknown[] = [];
  const raw: RawPort = {
    name: TASK_PORT,
    sender: { id: 'ext-id', url: senderUrl },
    postMessage: (m) => void posted.push(m),
    disconnect: vi.fn(),
    onMessage,
    onDisconnect: ev(),
  };
  const send = (m: unknown) => [...onMessage.listeners].forEach((l) => l(m));
  return { raw, posted, send };
}

describe('task service (port boundary)', () => {
  const host = {} as AgentHost;
  const logger = createLogger({ component: 'bg', sinks: [new MemorySink()] });

  it('refuses connections that are not from its own extension pages', () => {
    const { raw, onConnect } = api();
    startTaskService({ adapter: createAdapter('chrome', raw), host, logger });
    const p = port('https://evil.test/');
    [...onConnect.listeners].forEach((l) => l(p.raw));
    expect(p.posted).toEqual([
      { type: 'TASK_ERROR', code: 'UNTRUSTED_SENDER', message: 'Not a Techie Mind page.' },
    ]);
    expect(p.raw.disconnect).toHaveBeenCalled();
  });

  it('rejects malformed task requests and ignores keep-alives', () => {
    const { raw, onConnect } = api();
    startTaskService({ adapter: createAdapter('chrome', raw), host, logger });
    const p = port('chrome-extension://ext-id/sidepanel/index.html');
    [...onConnect.listeners].forEach((l) => l(p.raw));
    p.send({ type: 'KEEPALIVE' });
    p.send({ type: 'RUN_TASK', text: '', mode: 'search', source: 'typed' });
    p.send({ type: 'RUN_SCRIPT', code: 'x' });
    expect(p.posted).toEqual([
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

  it('releases the busy lock before announcing a result (regression: back-to-back tasks)', async () => {
    const { raw, onConnect, store } = api();
    startTaskService({ adapter: createAdapter('chrome', raw), host, logger });
    const p = port('chrome-extension://ext-id/sidepanel/index.html');
    [...onConnect.listeners].forEach((l) => l(p.raw));
    // 'please' resolves to an unknown intent: the runner finishes without touching the browser.
    const request = { type: 'RUN_TASK', text: 'please', mode: 'search', source: 'typed' };
    const results = () => p.posted.filter((m) => (m as { type: string }).type === 'TASK_RESULT');
    // Re-send synchronously inside the delivery of the first result — exactly what a client does.
    const deliver = p.raw.postMessage;
    let resent = false;
    p.raw.postMessage = (m: unknown) => {
      deliver(m);
      if ((m as { type: string }).type === 'TASK_RESULT' && !resent) {
        resent = true;
        p.send(request);
      }
    };
    p.send(request);
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(p.posted.some((m) => (m as { code?: string }).code === 'BUSY')).toBe(false);
    expect(Array.isArray(store['techieMind.history']) && store['techieMind.history'].length).toBe(
      2,
    );
  });
});

describe('ExtensionHost — task context (Phase 1 correction)', () => {
  function fakeAdapter(opts: {
    active: { id: number; url: string | null; title: string | null } | null;
    tabs?: Record<number, { url: string; title: string }>;
    stored?: unknown;
  }) {
    const store: Record<string, unknown> = { 'techieMind.agentTab': opts.stored };
    const focused: number[] = [];
    return {
      store,
      focused,
      adapter: {
        focusTab: async (id: number) => void focused.push(id),
        tabsOpenedBy: async (opener: number) => (opener === 9 ? [21, 22] : []),
        activeTab: async () => opts.active,
        getTab: async (id: number) => {
          const t = opts.tabs?.[id];
          return t ? { id, url: t.url, status: 'complete', title: t.title } : null;
        },
        openTab: async () => 99,
        navigateTab: async () => undefined,
        storageGet: async (k: string) => store[k],
        storageSet: async (k: string, v: unknown) => void (store[k] = v),
      } as unknown as BrowserAdapter,
    };
  }

  it('uses the active web tab as the context', async () => {
    const { adapter } = fakeAdapter({
      active: {
        id: 5,
        url: 'https://www.youtube.com/results?search_query=x',
        title: 'x - YouTube',
      },
    });
    expect(await new ExtensionHost(adapter).currentContext()).toMatchObject({
      tabId: 5,
      host: 'www.youtube.com',
      origin: 'https://www.youtube.com',
      source: 'active-tab',
    });
  });

  it('falls back to the tab the agent last worked in when the active tab is not a web page', async () => {
    const { adapter, store } = fakeAdapter({
      active: { id: 1, url: 'chrome-extension://ext-id/sidepanel/index.html', title: null },
      tabs: { 9: { url: 'https://www.flipkart.com/', title: 'Flipkart' } },
    });
    const host = new ExtensionHost(adapter);
    expect(await host.currentContext()).toBeNull();
    await host.navigate(9, 'https://www.flipkart.com/');
    expect(store['techieMind.agentTab']).toEqual({ tabId: 9 });
    expect(await host.currentContext()).toMatchObject({ tabId: 9, source: 'agent-tab' });
    // Survives a service-worker restart via storage.
    expect(await new ExtensionHost(adapter).currentContext()).toMatchObject({ tabId: 9 });
  });

  it('never offers a browser page or a closed tab as context', async () => {
    const { adapter } = fakeAdapter({
      active: { id: 1, url: 'chrome://newtab/', title: 'New Tab' },
      stored: { tabId: 404 },
    });
    expect(await new ExtensionHost(adapter).currentContext()).toBeNull();
  });

  it('reuses (and shows) the agent tab instead of opening a new one when a browser page is in front (bug B6)', async () => {
    const { adapter, focused } = fakeAdapter({
      active: { id: 1, url: 'chrome://extensions/', title: 'Extensions' },
      tabs: { 9: { url: 'https://www.flipkart.com/search?q=iphone', title: 'Flipkart' } },
      stored: { tabId: 9 },
    });
    expect(await new ExtensionHost(adapter).prepareTab()).toBe(9);
    expect(focused).toEqual([9]);
    // No usable agent tab: a new tab is still opened.
    const none = fakeAdapter({ active: { id: 1, url: 'chrome://extensions/', title: null } });
    expect(await new ExtensionHost(none.adapter).prepareTab()).toBe(99);
  });

  it('lists tabs a click opened and adopts one as the agent tab (bug B5)', async () => {
    const { adapter, store, focused } = fakeAdapter({ active: null });
    const host = new ExtensionHost(adapter);
    expect(await host.openedTabs(9)).toEqual([21, 22]);
    await host.adoptTab(22);
    expect(focused).toEqual([22]);
    expect(store['techieMind.agentTab']).toEqual({ tabId: 22 });
  });
});

describe('probeWebsite — resolution fetch boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches https origins without cookies or referrer and returns bounded evidence', async () => {
    const fetchSpy = vi.fn(async () => {
      const body = `<title>Lumora</title>${'x'.repeat(400_000)}`;
      const response = new Response(body, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://www.lumora.com/' });
      return response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const probe = await probeWebsite('https://lumora.com/');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://lumora.com/',
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
      }),
    );
    expect(probe).toMatchObject({ status: 200, finalUrl: 'https://www.lumora.com/', error: null });
    expect(probe.body.startsWith('<title>Lumora</title>')).toBe(true);
    expect(probe.body.length).toBeLessThanOrEqual(300_000);
  });

  it('refuses non-https or path-bearing URLs and reports network failures as evidence', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    for (const bad of ['http://lumora.com/', 'https://lumora.com/admin', 'ftp://lumora.com/']) {
      expect((await probeWebsite(bad)).error).toMatch(/only https/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await probeWebsite('https://nosuch-host-zz.com/')).toMatchObject({
      status: null,
      error: 'Failed to fetch',
    });
    // Reserved / private names never leave the browser: the privacy gate refuses them first.
    const before = fetchSpy.mock.calls.length;
    expect((await probeWebsite('https://router.local/')).error).toMatch(/privacy gate/);
    expect(fetchSpy.mock.calls.length).toBe(before);
  });
});
