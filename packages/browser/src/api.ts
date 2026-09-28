/**
 * The minimal subset of the WebExtension API surface the adapter relies on. Both Chrome MV3 and
 * Firefox MV3 expose these on the promise-returning `chrome` namespace; keeping the surface this
 * small lets tests inject a fake and keeps browser-specific calls in one place.
 */

export interface MessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
}

export type RawMessageListener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

export interface ExtensionEvent<L> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export interface TabInfo {
  id?: number;
  url?: string;
  status?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
  /** The tab whose page opened this one (e.g. a target="_blank" link). */
  openerTabId?: number;
}

export interface RawPort {
  name: string;
  sender?: MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ExtensionEvent<(message: unknown) => void>;
  onDisconnect: ExtensionEvent<() => void>;
}

export interface WebExtensionApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    openOptionsPage(): Promise<void>;
    onMessage: ExtensionEvent<RawMessageListener>;
    connect(info: { name: string }): RawPort;
    onConnect: ExtensionEvent<(port: RawPort) => void>;
  };
  storage: {
    local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: ExtensionEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  };
  tabs: {
    query(query: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }): Promise<TabInfo[]>;
    get(tabId: number): Promise<TabInfo>;
    sendMessage(tabId: number, message: unknown, options?: { frameId?: number }): Promise<unknown>;
    create(props: { url: string; active?: boolean }): Promise<TabInfo>;
    update(tabId: number, props: { url?: string; active?: boolean }): Promise<TabInfo>;
    goBack(tabId: number): Promise<void>;
    captureVisibleTab(
      windowId: number,
      options: { format: 'png' | 'jpeg'; quality?: number },
    ): Promise<string>;
  };
  scripting?: {
    executeScript(injection: {
      target: { tabId: number; frameIds?: number[] };
      files: string[];
    }): Promise<unknown>;
  };
  action?: {
    onClicked: ExtensionEvent<() => void>;
  };
  /** Chrome only. */
  sidePanel?: {
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  };
  /** Firefox only. */
  sidebarAction?: {
    open(): Promise<void>;
  };
}
