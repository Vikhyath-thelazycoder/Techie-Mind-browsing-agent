import { describe, expect, it, vi } from 'vitest';
import {
  createAdapter,
  type RawMessageListener,
  type RawPort,
  type WebExtensionApi,
} from '../src/index.js';

function event<L>() {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: (l: L) => void listeners.add(l),
    removeListener: (l: L) => void listeners.delete(l),
  };
}

function fakeApi(overrides: Partial<WebExtensionApi> = {}) {
  const store: Record<string, unknown> = {};
  const onMessage = event<RawMessageListener>();
  const onChanged = event<(c: Record<string, { newValue?: unknown }>, area: string) => void>();
  const onClicked = event<() => void>();
  const onConnect = event<(port: RawPort) => void>();
  const update = vi.fn(async (id: number, _props: { url?: string }) => ({ id }));
  const api: WebExtensionApi = {
    runtime: {
      id: 'ext-id',
      getURL: (p) => `chrome-extension://ext-id/${p}`,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: vi.fn(async () => ({ type: 'OK', ok: true })),
      openOptionsPage: vi.fn(async () => {}),
      onMessage,
      connect: vi.fn(),
      onConnect,
    },
    storage: {
      local: {
        get: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
        },
        set: async (items) => {
          Object.assign(store, items);
          for (const l of onChanged.listeners)
            l(
              Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])),
              'local',
            );
        },
      },
      onChanged,
    },
    tabs: {
      query: async () => [{ id: 42, url: 'https://www.youtube.com/' }],
      sendMessage: vi.fn(async () => ({ ok: true })),
      create: async () => ({ id: 43 }),
      get: async (id) => {
        if (id === 404) throw new Error('No tab with id');
        return { id, url: 'https://www.youtube.com/', status: 'complete' };
      },
      update,
      goBack: vi.fn(async () => {}),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,AAAA'),
    },
    action: { onClicked },
    ...overrides,
  };
  return { api, onMessage, onClicked, onConnect, update };
}

describe('browser adapter', () => {
  it('trusts only this extension’s own pages for privileged requests', () => {
    const adapter = createAdapter('chrome', fakeApi().api);
    expect(
      adapter.isOwnExtensionPage({ id: 'ext-id', url: 'chrome-extension://ext-id/sidepanel.html' }),
    ).toBe(true);
    // A content script (has a tab) is not an extension page.
    expect(
      adapter.isOwnExtensionPage({ id: 'ext-id', url: 'https://evil.test/', tab: { id: 1 } }),
    ).toBe(false);
    // Another extension is never trusted.
    expect(
      adapter.isOwnExtensionPage({ id: 'other', url: 'chrome-extension://other/page.html' }),
    ).toBe(false);
  });

  it('trusts its own page when opened in a full tab (regression: found in real Chromium)', () => {
    const adapter = createAdapter('chrome', fakeApi().api);
    expect(
      adapter.isOwnExtensionPage({
        id: 'ext-id',
        url: 'chrome-extension://ext-id/sidepanel/index.html',
        tab: { id: 9 },
      }),
    ).toBe(true);
  });

  it('identifies its own content scripts', () => {
    const adapter = createAdapter('chrome', fakeApi().api);
    expect(
      adapter.isOwnContentScript({ id: 'ext-id', url: 'https://www.youtube.com/', tab: { id: 5 } }),
    ).toBe(true);
    expect(adapter.isOwnContentScript({ id: 'ext-id' })).toBe(false);
    // An extension page in a tab is not a content script.
    expect(
      adapter.isOwnContentScript({
        id: 'ext-id',
        url: 'chrome-extension://ext-id/sidepanel/index.html',
        tab: { id: 5 },
      }),
    ).toBe(false);
  });

  it('delivers async handler results through sendResponse and keeps the channel open', async () => {
    const { api, onMessage } = fakeApi();
    const adapter = createAdapter('chrome', api);
    adapter.onMessage(async () => ({ type: 'OK', ok: true }));
    const [listener] = [...onMessage.listeners];
    const sendResponse = vi.fn();
    expect(listener?.({ type: 'X' }, { id: 'ext-id' }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ type: 'OK', ok: true }));
  });

  it('converts handler failures into a structured error response', async () => {
    const { api, onMessage } = fakeApi();
    createAdapter('chrome', api).onMessage(async () => {
      throw new Error('boom');
    });
    const sendResponse = vi.fn();
    [...onMessage.listeners][0]?.({}, {}, sendResponse);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'ERROR',
        ok: false,
        code: 'INTERNAL',
        message: 'boom',
      }),
    );
  });

  it('returns undefined (no response) when the handler ignores a message', () => {
    const { api, onMessage } = fakeApi();
    createAdapter('chrome', api).onMessage(() => undefined);
    expect([...onMessage.listeners][0]?.({}, {}, vi.fn())).toBeUndefined();
  });

  it('round-trips storage and notifies key-scoped listeners', async () => {
    const adapter = createAdapter('chrome', fakeApi().api);
    const seen: unknown[] = [];
    adapter.onStorageChange('settings', (v) => seen.push(v));
    await adapter.storageSet('settings', { a: 1 });
    await adapter.storageSet('other', 2);
    expect(await adapter.storageGet('settings')).toEqual({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });

  it('returns the active tab', async () => {
    expect(await createAdapter('chrome', fakeApi().api).activeTab()).toEqual({
      id: 42,
      url: 'https://www.youtube.com/',
      title: null,
    });
  });

  it('uses chrome.sidePanel on Chrome', async () => {
    const setPanelBehavior = vi.fn(async () => {});
    const adapter = createAdapter('chrome', fakeApi({ sidePanel: { setPanelBehavior } }).api);
    await adapter.enablePanelOnActionClick();
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it('uses sidebarAction from the toolbar click on Firefox', async () => {
    const open = vi.fn(async () => {});
    const { api, onClicked } = fakeApi({ sidebarAction: { open } });
    await createAdapter('firefox', api).enablePanelOnActionClick();
    [...onClicked.listeners][0]?.();
    expect(open).toHaveBeenCalledOnce();
  });

  it('fails loudly when the platform panel API is missing', async () => {
    await expect(createAdapter('chrome', fakeApi().api).enablePanelOnActionClick()).rejects.toThrow(
      /sidePanel/,
    );
  });

  it('navigates tabs only to web URLs', async () => {
    const { api, update } = fakeApi();
    const adapter = createAdapter('chrome', api);
    await adapter.navigateTab(42, 'https://www.flipkart.com/');
    expect(update).toHaveBeenCalledWith(42, { url: 'https://www.flipkart.com/' });
    // eslint-disable-next-line no-script-url -- hostile input under test: must be refused
    await expect(adapter.navigateTab(42, 'javascript:alert(1)')).rejects.toThrow(/non-web/);
    await expect(adapter.navigateTab(42, 'file:///etc/passwd')).rejects.toThrow(/non-web/);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('reports a closed tab as null instead of throwing', async () => {
    const adapter = createAdapter('chrome', fakeApi().api);
    expect(await adapter.getTab(404)).toBeNull();
    expect(await adapter.getTab(42)).toEqual({
      id: 42,
      url: 'https://www.youtube.com/',
      status: 'complete',
      title: null,
    });
  });

  it('injects bundled scripts into the top frame only', async () => {
    const executeScript = vi.fn(async () => []);
    const adapter = createAdapter('chrome', fakeApi({ scripting: { executeScript } }).api);
    await adapter.injectScript(7, 'content.js');
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [0] },
      files: ['content.js'],
    });
    await expect(
      createAdapter('chrome', fakeApi().api).injectScript(7, 'content.js'),
    ).rejects.toThrow(/scripting/);
  });

  it('delivers connections only for the requested channel name', () => {
    const { api, onConnect } = fakeApi();
    const handler = vi.fn();
    createAdapter('chrome', api).onConnect('techie-mind/task', handler);
    const port = (name: string): RawPort => ({
      name,
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    });
    for (const l of onConnect.listeners) {
      l(port('something-else'));
      l(port('techie-mind/task'));
    }
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].name).toBe('techie-mind/task');
  });
});
