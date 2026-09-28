import type { MessageSender, RawPort, StorageChange, TabInfo, WebExtensionApi } from './api.js';

export type BrowserKind = 'chrome' | 'firefox';

/** A long-lived messaging channel (used to stream task progress). */
export interface Port {
  readonly name: string;
  readonly sender: MessageSender | undefined;
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  disconnect(): void;
}

export interface TabState {
  id: number;
  url: string | null;
  /** "loading" | "complete" (browser tab loading status). */
  status: string | null;
  title: string | null;
}

function wrapPort(raw: RawPort): Port {
  return {
    name: raw.name,
    sender: raw.sender,
    post: (message) => raw.postMessage(message),
    onMessage: (listener) => raw.onMessage.addListener(listener),
    onDisconnect: (listener) => raw.onDisconnect.addListener(listener),
    disconnect: () => raw.disconnect(),
  };
}

function toTabState(tab: TabInfo): TabState | null {
  if (typeof tab.id !== 'number') return null;
  return {
    id: tab.id,
    url: tab.url ?? null,
    status: tab.status ?? null,
    title: tab.title ?? null,
  };
}

export type MessageHandler = (
  message: unknown,
  sender: MessageSender,
) => Promise<unknown> | undefined;

/** Browser-neutral surface used by shared Techie Mind code. */
export interface BrowserAdapter {
  readonly kind: BrowserKind;
  readonly extensionId: string;
  readonly version: string;
  getURL(path: string): string;
  /** True only for pages served from this extension (side panel, settings) — never web pages. */
  isOwnExtensionPage(sender: MessageSender): boolean;
  /** True for this extension's content scripts running in a tab. */
  isOwnContentScript(sender: MessageSender): boolean;
  sendMessage(message: unknown): Promise<unknown>;
  sendToTab(tabId: number, message: unknown): Promise<unknown>;
  onMessage(handler: MessageHandler): () => void;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  onStorageChange(key: string, listener: (value: unknown) => void): () => void;
  activeTab(): Promise<{ id: number; url: string | null; title: string | null } | null>;
  openTab(url: string): Promise<number | null>;
  getTab(tabId: number): Promise<TabState | null>;
  /** Ids of open tabs that were opened from `openerTabId` (target="_blank" links, window.open). */
  tabsOpenedBy(openerTabId: number): Promise<number[]>;
  /** Bring a tab to the front of its window. */
  focusTab(tabId: number): Promise<void>;
  /** Browser-level navigation of an existing tab. */
  navigateTab(tabId: number, url: string): Promise<void>;
  goBack(tabId: number): Promise<void>;
  /**
   * PNG data URL of what the tab shows right now, or null when it is not the visible tab of its
   * window (the browser can only capture visible tabs).
   */
  captureTab(tabId: number): Promise<string | null>;
  /** Inject a bundled extension script (path inside the package) into a tab's top frame. */
  injectScript(tabId: number, file: string): Promise<void>;
  /** Accept long-lived connections on a named channel. */
  onConnect(name: string, handler: (port: Port) => void): () => void;
  connect(name: string): Port;
  openSettings(): Promise<void>;
  /** Make the toolbar button open the Techie Mind panel (side panel on Chrome, sidebar on Firefox). */
  enablePanelOnActionClick(): Promise<void>;
}

export function createAdapter(kind: BrowserKind, api: WebExtensionApi): BrowserAdapter {
  const baseUrl = api.runtime.getURL('');

  return {
    kind,
    extensionId: api.runtime.id,
    version: api.runtime.getManifest().version,

    getURL: (path) => api.runtime.getURL(path),

    // Trust is decided by the sender's document URL, not by whether it lives in a tab: the side panel
    // UI may be opened in a full tab ("Tab" button). Content scripts always report the web page URL,
    // so they can never pass this check.
    isOwnExtensionPage(sender) {
      return (
        sender.id === api.runtime.id &&
        typeof sender.url === 'string' &&
        sender.url.startsWith(baseUrl)
      );
    },

    isOwnContentScript(sender) {
      return (
        sender.id === api.runtime.id &&
        typeof sender.tab?.id === 'number' &&
        typeof sender.url === 'string' &&
        !sender.url.startsWith(baseUrl)
      );
    },

    sendMessage: (message) => api.runtime.sendMessage(message),

    sendToTab: (tabId, message) => api.tabs.sendMessage(tabId, message),

    onMessage(handler) {
      const listener = (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response: unknown) => void,
      ): boolean | undefined => {
        const pending = handler(message, sender);
        if (pending === undefined) return undefined;
        pending.then(sendResponse, (error: unknown) =>
          sendResponse({
            type: 'ERROR',
            ok: false,
            code: 'INTERNAL',
            message: error instanceof Error ? error.message.slice(0, 500) : 'internal error',
          }),
        );
        return true; // keep the channel open for the async response (Chrome + Firefox)
      };
      api.runtime.onMessage.addListener(listener);
      return () => api.runtime.onMessage.removeListener(listener);
    },

    async storageGet(key) {
      const items = await api.storage.local.get(key);
      return items[key];
    },

    storageSet: (key, value) => api.storage.local.set({ [key]: value }),

    onStorageChange(key, listener) {
      const wrapped = (changes: Record<string, StorageChange>, areaName: string) => {
        const change = changes[key];
        if (areaName === 'local' && change) listener(change.newValue);
      };
      api.storage.onChanged.addListener(wrapped);
      return () => api.storage.onChanged.removeListener(wrapped);
    },

    async activeTab() {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab || typeof tab.id !== 'number') return null;
      return { id: tab.id, url: tab.url ?? null, title: tab.title ?? null };
    },

    async openTab(url) {
      const tab = await api.tabs.create({ url, active: true });
      return typeof tab.id === 'number' ? tab.id : null;
    },

    async getTab(tabId) {
      try {
        return toTabState(await api.tabs.get(tabId));
      } catch {
        return null; // tab closed
      }
    },

    async navigateTab(tabId, url) {
      const protocol = new URL(url).protocol;
      if (protocol !== 'https:' && protocol !== 'http:') {
        throw new Error(`refusing to navigate to non-web URL (${protocol})`);
      }
      await api.tabs.update(tabId, { url });
    },

    goBack: (tabId) => api.tabs.goBack(tabId),

    async captureTab(tabId) {
      try {
        const tab = await api.tabs.get(tabId);
        if (!tab.active || typeof tab.windowId !== 'number') return null;
        return await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch {
        return null;
      }
    },

    async tabsOpenedBy(openerTabId) {
      const tabs = await api.tabs.query({});
      return tabs
        .filter((t) => t.openerTabId === openerTabId && typeof t.id === 'number')
        .map((t) => t.id as number);
    },

    async focusTab(tabId) {
      await api.tabs.update(tabId, { active: true });
    },

    async injectScript(tabId, file) {
      if (!api.scripting) throw new Error('scripting API is unavailable');
      await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [file] });
    },

    onConnect(name, handler) {
      const listener = (raw: RawPort) => {
        if (raw.name === name) handler(wrapPort(raw));
      };
      api.runtime.onConnect.addListener(listener);
      return () => api.runtime.onConnect.removeListener(listener);
    },

    connect: (name) => wrapPort(api.runtime.connect({ name })),

    openSettings: () => api.runtime.openOptionsPage(),

    async enablePanelOnActionClick() {
      if (kind === 'chrome') {
        if (!api.sidePanel) throw new Error('chrome.sidePanel is unavailable');
        await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        return;
      }
      const { sidebarAction, action } = api;
      if (!sidebarAction || !action) throw new Error('sidebarAction/action is unavailable');
      // Firefox only allows sidebarAction.open() from a user-gesture handler.
      action.onClicked.addListener(() => void sidebarAction.open());
    },
  };
}
