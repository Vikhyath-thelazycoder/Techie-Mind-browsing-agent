import type {
  Action,
  ExecuteResponse,
  Observation,
  PrivacyScanResponse,
  ProbeResponse,
  WebsiteProbe,
} from '@techie-mind/contracts';
import type { RedactedImage } from '@techie-mind/privacy';
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
  execute(tabId: number, action: Action): Promise<ExecuteResponse>;
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
  captureVisible?(tabId: number, options: { people: boolean }): Promise<VisualCapture | null>;
}
