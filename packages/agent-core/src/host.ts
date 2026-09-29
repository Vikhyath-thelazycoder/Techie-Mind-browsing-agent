import type {
  Action,
  ExecuteResponse,
  ExtractItemsResponse,
  ExtractTextResponse,
  UserProfile,
  Observation,
  PrivacyScanResponse,
  ProbeResponse,
  WebsiteProbe,
} from '@techie-mind/contracts';
import type { Monitor } from '@techie-mind/contracts';
import type { RedactedImage } from '@techie-mind/privacy';

/** Browser data the skills work with (Phase 6). URLs are stored without query strings. */
export interface BookmarkEntry {
  id: string;
  url: string;
  title: string;
}
export interface TabEntry {
  id: number;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  windowId: number;
}
export interface SavedPage {
  url: string;
  title: string;
  savedAt: number;
}
/** Where a new monitor went and what the user should know about it. */
export interface MonitorSaveResult {
  backend: boolean;
  note: string;
}

export interface BrowserData {
  bookmarks: {
    search(query: string): Promise<BookmarkEntry[]>;
    add(entry: { url: string; title: string }): Promise<BookmarkEntry>;
    remove(id: string): Promise<void>;
  };
  tabs: {
    list(): Promise<TabEntry[]>;
    /** Group tabs under a title; false when the browser has no tab groups. */
    group(tabIds: number[], title: string): Promise<boolean>;
    close(tabIds: number[]): Promise<void>;
  };
  readLater: {
    add(page: SavedPage): Promise<void>;
    list(): Promise<SavedPage[]>;
    remove(url: string): Promise<boolean>;
  };
  monitors: {
    /**
     * Store the monitor. With the monitoring backend connected it is also created there, so it is
     * checked (and alerts are e-mailed) while the browser is closed.
     */
    add(monitor: Monitor, label?: string): Promise<MonitorSaveResult | void>;
    list(): Promise<Monitor[]>;
  };
  /** Hand a file to the browser's download manager (text, or base64 for binary). */
  download(file: {
    name: string;
    mime: string;
    content: string;
    base64?: boolean;
  }): Promise<boolean>;
}
import type { TabContext } from './router.js';

/** The visible tab after local redaction (Phase 4). The raw screenshot never leaves the host. */
export interface VisualCapture {
  image: RedactedImage;
  /** Image pixels per CSS pixel. */
  scale: number;
  scrollX: number;
  scrollY: number;
  /** Capture + redaction time. */
  ms: number;
}

/**
 * Everything the agent core needs from the browser. The core never touches browser APIs itself:
 * the extension implements this over the BrowserAdapter + content-script protocol, and tests
 * implement it over a scripted page model. Every method returns contract-validated data.
 */
export interface AgentHost {
  /**
   * The web tab in front of the user when a task starts (the active tab; if that is not a web page,
   * the tab the agent last worked in, when it still exists). Null when there is no usable web tab.
   */
  currentContext(): Promise<TabContext | null>;
  /** Choose (or create) the tab for a task that navigates somewhere new. */
  prepareTab(): Promise<number>;
  /**
   * Fetch candidate websites for name resolution (https only, no cookies, bounded time and size).
   * One result per URL, in order; failures are reported in the result, never thrown.
   */
  probeWebsites(urls: readonly string[]): Promise<WebsiteProbe[]>;
  /** The user's region (ISO 3166 alpha-2 from the browser locale), for regional domains. */
  region(): string | null;
  /** Browser-level navigation of the agent's tab (the NAVIGATE primitive). */
  navigate(tabId: number, url: string): Promise<void>;
  /**
   * Tabs that were opened from `openerTabId` (links with target="_blank"). Optional: hosts without
   * tab tracking only see same-tab navigations.
   */
  openedTabs?(openerTabId: number): Promise<number[]>;
  /** Make a tab the agent opened its working tab (focused and remembered for follow-ups). */
  adoptTab?(tabId: number): Promise<void>;
  /** Browser-level history back (used by recovery after opening a wrong result). */
  goBack(tabId: number): Promise<void>;
  /**
   * Wait until the tab is loaded and its DOM is quiet. With `since`, first wait (up to the timeout)
   * for the page to differ from that probe (URL, document or DOM version). Returns null when the
   * tab shows no web document.
   */
  settle(
    tabId: number,
    options: { since: ProbeResponse | null; timeoutMs: number },
  ): Promise<ProbeResponse | null>;
  observe(tabId: number, taskId: string, observationId: string): Promise<Observation>;
  /**
   * Execute a bound action. `resolved` carries the value of a TYPE action's vault token, resolved
   * by the runner after the firewall authorized the action (the Action itself never holds it).
   */
  execute(
    tabId: number,
    action: Action,
    resolved?: { vaultToken: string; text: string },
    /** The user's attached file for an UPLOAD action (after the firewall allowed it). */
    file?: { fileRef: string; name: string; mime: string; base64: string },
  ): Promise<ExecuteResponse>;
  probe(tabId: number, elementId: string | null): Promise<ProbeResponse | null>;
  /**
   * Whole-page privacy scan run inside the page (counts only). Optional: hosts without it fall
   * back to scanning the observation.
   */
  scanPage?(tabId: number): Promise<PrivacyScanResponse | null>;
  /**
   * Capture the visible part of the tab with every sensitive region painted over (text the
   * detectors flag, sensitive fields, and — with `people` — images of people). Optional: hosts
   * without it have no visual fallback. Null when the tab cannot be captured (not visible).
   */
  captureVisible?(
    tabId: number,
    options: {
      people: boolean;
      /** Numbered boxes drawn on the redacted image (screenshot walkthrough), page CSS pixels. */
      marks?: Array<{
        box: { x: number; y: number; width: number; height: number };
        label: string;
      }>;
    },
  ): Promise<VisualCapture | null>;
  /** Phase 6: bookmarks, tabs, read-later, monitors and downloads for the skills. */
  browserData?: BrowserData | undefined;
  /** Phase 5: repeated items (title, price, link element) on the page, extracted in the page. */
  extractItems?(tabId: number): Promise<ExtractItemsResponse | null>;
  /** Phase 5: main readable text of the page (stays local until redacted by the runner). */
  extractText?(tabId: number): Promise<ExtractTextResponse | null>;
  /**
   * Phase 5: a trusted (browser-level) click at the centre of a bound element — used for media so
   * playback may start with sound. Only after the firewall authorized the same CLICK action.
   * Resolves false when trusted input is not available (then the normal click is used).
   */
  trustedClick?(tabId: number, elementId: string): Promise<boolean>;
  /** The page this tab showed before its current one, as seen by the agent (same session). */
  previousUrl?(tabId: number): Promise<string | null>;
  /** Browser-level history forward. */
  goForward?(tabId: number): Promise<void>;
  /** Phase 5: the user's saved profile, decrypted locally; null when none is saved. */
  loadProfile?(): Promise<UserProfile | null>;
}
