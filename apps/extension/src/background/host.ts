import type { AgentHost, BrowserData, TabContext, VisualCapture } from '@techie-mind/agent-core';
import type { BrowserAdapter } from '@techie-mind/browser';
import { gatedFetch, OutboundPrivacyGate, PrivacyGateError } from '@techie-mind/privacy';
import { loadProfile } from '../shared/profile-store.js';
import { redactCapture, type CaptureMark } from './capture.js';
import {
  ContentPong,
  ErrorResponse,
  ExecuteResponse,
  ObserveResponse,
  ElementRectResponse,
  ExtractItemsResponse,
  ExtractTextResponse,
  PrivacyRegionsResponse,
  PrivacyScanResponse,
  type UserProfile,
  ProbeResponse,
  WebsiteProbe,
  type Action,
  type Observation,
} from '@techie-mind/contracts';

/** Every network request the background makes passes this gate (plan §20). */
export const OUTBOUND_GATE = new OutboundPrivacyGate();

/** Storage key for the tab the agent last worked in (tab id only — never a URL). */
export const AGENT_TAB_KEY = 'techieMind.agentTab';

const PROBE_TIMEOUT_MS = 4_500;
/** Page identity (title, site name, refresh) lives in the head: never read more than this. */
const PROBE_MAX_BYTES = 256 * 1024;

function toContext(
  tabId: number,
  url: string,
  title: string | null,
  source: TabContext['source'],
): TabContext {
  const parsed = new URL(url);
  return {
    tabId,
    url,
    origin: parsed.origin,
    host: parsed.hostname,
    title: (title ?? '').slice(0, 300),
    source,
  };
}

/** Fetch one candidate website. Never throws: failures are part of the evidence. */
export async function probeWebsite(url: string): Promise<WebsiteProbe> {
  const started = Date.now();
  const fail = (error: string, status: number | null = null): WebsiteProbe =>
    WebsiteProbe.parse({
      url,
      status,
      finalUrl: null,
      body: '',
      error: error.slice(0, 200),
      ms: Date.now() - started,
    });
  if (!/^https:\/\/[a-z0-9.-]+\/$/.test(url)) return fail('only https origins are probed');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Through the outbound privacy gate: https public hosts only, no body, no cookies/referrer.
    const response = await gatedFetch(
      OUTBOUND_GATE,
      { purpose: 'website-probe', url },
      { signal: controller.signal },
    );
    const body = await readPrefix(response, PROBE_MAX_BYTES);
    const finalUrl = /^https?:\/\//i.test(response.url) ? response.url : url;
    return WebsiteProbe.parse({
      url,
      status: response.status,
      finalUrl: finalUrl.slice(0, 2048),
      body,
      error: null,
      ms: Date.now() - started,
    });
  } catch (error) {
    if (error instanceof PrivacyGateError)
      return fail(`blocked by the privacy gate (${error.decision.check})`);
    const aborted = controller.signal.aborted;
    return fail(aborted ? 'timed out' : error instanceof Error ? error.message : 'network error');
  } finally {
    clearTimeout(timer);
  }
}

async function readPrefix(response: Response, maxBytes: number): Promise<string> {
  const type = response.headers.get('content-type') ?? '';
  if (type && !/html|xml|text/i.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    return '';
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, 300_000);
}

/** Bundled content script (injected on demand; never declared for all pages). */
export const CONTENT_SCRIPT = 'content.js';

const MESSAGE_TIMEOUT_MS = 5_000;
const CHANGE_WINDOW_MS = 5_000;
const POLL_MS = 100;
const STABLE_INTERVAL_MS = 300;
/** DOM counts as quiet when at most this many mutation batches happen in one interval. */
const QUIET_MUTATIONS = 2;
/**
 * Some pages never become DOM-quiet (auto-playing heroes, carousels, live counters). Once such a
 * page has finished loading and kept the same URL and document this long, it counts as settled.
 */
const BUSY_PAGE_SETTLED_MS = 2_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isWebUrl(url: string | null): boolean {
  return url !== null && /^https?:\/\//i.test(url);
}

/** Tabs the agent may take over: ordinary web pages and empty/new-tab pages. */
function isReusable(url: string | null): boolean {
  if (url === null || url === '' || url === 'about:blank') return true;
  if (
    /^(chrome|edge|brave):\/\/newtab\/?$/i.test(url) ||
    url === 'about:newtab' ||
    url === 'about:home'
  )
    return true;
  return isWebUrl(url);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AgentHost over the BrowserAdapter and the content-script protocol. All browser access goes
 * through the adapter; all content responses are contract-validated before use.
 */
export class ExtensionHost implements AgentHost {
  #agentTab: number | null = null;

  constructor(
    private readonly adapter: BrowserAdapter,
    /** Phase 6: bookmarks, tabs, read-later, monitors, downloads (absent in unit tests). */
    readonly browserData?: BrowserData,
  ) {}

  /**
   * The web tab in front of the user; when the active tab is not a web page (e.g. the extension's
   * own page, a new tab), the tab the agent last worked in — so a follow-up command continues there.
   */
  async currentContext(): Promise<TabContext | null> {
    const active = await this.adapter.activeTab();
    if (active && isWebUrl(active.url)) {
      return toContext(active.id, active.url!, active.title, 'active-tab');
    }
    const remembered = this.#agentTab ?? (await this.#storedAgentTab());
    if (remembered === null) return null;
    const tab = await this.adapter.getTab(remembered);
    if (!tab || !isWebUrl(tab.url)) return null;
    return toContext(tab.id, tab.url!, tab.title, 'agent-tab');
  }

  async prepareTab(): Promise<number> {
    const active = await this.adapter.activeTab();
    if (active && isReusable(active.url)) return this.#remember(active.id);
    // A browser page is in front (e.g. chrome://extensions): continue in the agent's own tab, if it
    // is still open on a web page, rather than opening yet another tab.
    const remembered = this.#agentTab ?? (await this.#storedAgentTab());
    if (remembered !== null) {
      const tab = await this.adapter.getTab(remembered);
      if (tab && isWebUrl(tab.url)) {
        await this.adapter.focusTab(tab.id).catch(() => undefined);
        return this.#remember(tab.id);
      }
    }
    const id = await this.adapter.openTab('about:blank');
    if (id === null) throw new Error('could not open a tab for the task');
    return this.#remember(id);
  }

  async openedTabs(openerTabId: number): Promise<number[]> {
    return this.adapter.tabsOpenedBy(openerTabId);
  }

  /** A result opened in a new tab: show it and make it the tab follow-up commands continue in. */
  async adoptTab(tabId: number): Promise<void> {
    // The new tab has no history of its own; "go back" there means the page it was opened from.
    const from = this.#agentTab;
    const origin = from !== null ? this.#trail.get(from)?.at(-1) : undefined;
    if (origin && !this.#trail.has(tabId)) this.#trail.set(tabId, [origin]);
    await this.adapter.focusTab(tabId).catch(() => undefined);
    this.#remember(tabId);
  }

  async navigate(tabId: number, url: string): Promise<void> {
    await this.adapter.navigateTab(tabId, url);
    this.#remember(tabId);
  }

  region(): string | null {
    const locale = typeof navigator === 'undefined' ? '' : (navigator.language ?? '');
    const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1];
    return region ? region.toUpperCase() : null;
  }

  /**
   * Fetch candidate websites in parallel: https only, no cookies or referrer, bounded time and
   * body size. Only the page head is needed to read the site's identity.
   */
  async probeWebsites(urls: readonly string[]): Promise<WebsiteProbe[]> {
    return Promise.all(urls.map((url) => probeWebsite(url)));
  }

  #remember(tabId: number): number {
    if (this.#agentTab !== tabId) {
      this.#agentTab = tabId;
      void this.adapter.storageSet(AGENT_TAB_KEY, { tabId }).catch(() => undefined);
    }
    return tabId;
  }

  async #storedAgentTab(): Promise<number | null> {
    try {
      const stored = (await this.adapter.storageGet(AGENT_TAB_KEY)) as { tabId?: unknown } | null;
      return typeof stored?.tabId === 'number' ? stored.tabId : null;
    } catch {
      return null;
    }
  }

  async goBack(tabId: number): Promise<void> {
    await this.adapter.goBack(tabId);
  }

  async #send(tabId: number, message: unknown): Promise<unknown> {
    const reply = await withTimeout(
      this.adapter.sendToTab(tabId, message),
      MESSAGE_TIMEOUT_MS,
      'content message',
    );
    const error = ErrorResponse.safeParse(reply);
    if (error.success)
      throw new Error(`content script refused: ${error.data.code} ${error.data.message}`);
    return reply;
  }

  /** Make sure our content script is running in the tab's current document. */
  async #ensureContent(tabId: number): Promise<void> {
    try {
      ContentPong.parse(await this.#send(tabId, { type: 'CONTENT_PING' }));
      return;
    } catch {
      // Not injected in this document yet (or the page just navigated): inject and re-check.
    }
    await this.adapter.injectScript(tabId, CONTENT_SCRIPT);
    ContentPong.parse(await this.#send(tabId, { type: 'CONTENT_PING' }));
  }

  async probe(tabId: number, elementId: string | null): Promise<ProbeResponse | null> {
    const tab = await this.adapter.getTab(tabId);
    if (!tab) throw new Error('the agent tab was closed');
    if (!isWebUrl(tab.url)) return null;
    try {
      await this.#ensureContent(tabId);
    } catch (error) {
      // A failed load leaves the attempted URL on the tab but shows the browser's error page,
      // which no extension may script: that is "no web page", not an agent failure.
      if (error instanceof Error && /error page/i.test(error.message)) return null;
      throw error;
    }
    const probe = ProbeResponse.parse(await this.#send(tabId, { type: 'PROBE', elementId }));
    this.#see(tabId, probe.url);
    return probe;
  }

  /**
   * Level 4 capture: sensitive regions are located inside the page (geometry only), the visible tab
   * is captured and painted over locally — see capture.ts. Null when the tab is not visible.
   */
  async captureVisible(
    tabId: number,
    options: { people: boolean; marks?: CaptureMark[] },
  ): Promise<VisualCapture | null> {
    await this.#ensureContent(tabId);
    const regions = PrivacyRegionsResponse.parse(
      await this.#send(tabId, { type: 'PRIVACY_REGIONS', people: options.people }),
    );
    const shot = await this.adapter.captureTab(tabId);
    if (!shot) return null;
    return redactCapture(shot, regions, undefined, options.marks ?? []);
  }

  async scanPage(tabId: number): Promise<PrivacyScanResponse | null> {
    try {
      await this.#ensureContent(tabId);
      return PrivacyScanResponse.parse(await this.#send(tabId, { type: 'PRIVACY_SCAN' }));
    } catch {
      return null;
    }
  }

  async observe(tabId: number, taskId: string, observationId: string): Promise<Observation> {
    await this.#ensureContent(tabId);
    const reply = ObserveResponse.parse(
      await this.#send(tabId, { type: 'OBSERVE', taskId, observationId, tabId }),
    );
    if (reply.observation.tabId !== tabId || reply.observation.taskId !== taskId) {
      throw new Error('observation does not belong to this task/tab');
    }
    return reply.observation;
  }

  async execute(
    tabId: number,
    action: Action,
    resolved?: { vaultToken: string; text: string },
    file?: { fileRef: string; name: string; mime: string; base64: string },
  ): Promise<ExecuteResponse> {
    if (action.binding.tabId !== tabId) {
      // Cross-tab safety (spec §70): an action bound to another tab never runs here.
      return {
        type: 'EXECUTE_RESULT',
        actionId: action.actionId,
        status: 'rejected',
        code: 'DOCUMENT_MISMATCH',
        message: 'action is bound to a different tab',
        valueAfter: null,
        versionAfter: 0,
        deferred: false,
      };
    }
    await this.#ensureContent(tabId);
    return ExecuteResponse.parse(
      await this.#send(tabId, {
        type: 'EXECUTE',
        action,
        ...(resolved ? { resolved } : {}),
        ...(file ? { file } : {}),
      }),
    );
  }

  async extractItems(tabId: number): Promise<ExtractItemsResponse | null> {
    await this.#ensureContent(tabId);
    return ExtractItemsResponse.parse(await this.#send(tabId, { type: 'EXTRACT_ITEMS' }));
  }

  async extractText(tabId: number): Promise<ExtractTextResponse | null> {
    await this.#ensureContent(tabId);
    return ExtractTextResponse.parse(await this.#send(tabId, { type: 'EXTRACT_TEXT' }));
  }

  /** Trusted click at the centre of a bound element (the firewall already authorized the CLICK). */
  async trustedClick(tabId: number, elementId: string): Promise<boolean> {
    await this.#ensureContent(tabId);
    const where = ElementRectResponse.parse(
      await this.#send(tabId, { type: 'ELEMENT_RECT', elementId }),
    );
    if (!where.visible || !where.rect) return false;
    const { x, y, width, height } = where.rect;
    return this.adapter.trustedClickAt(tabId, x + width / 2, y + height / 2);
  }

  /** Pages the agent saw in each tab (in memory only; for "go back" when Chrome's list skips them). */
  readonly #trail = new Map<number, string[]>();

  #see(tabId: number, url: string) {
    const trail = this.#trail.get(tabId) ?? [];
    if (trail.at(-1) !== url) {
      if (trail.at(-2) === url)
        trail.pop(); // went back to it
      else trail.push(url);
    }
    this.#trail.set(tabId, trail.slice(-20));
  }

  async previousUrl(tabId: number): Promise<string | null> {
    const trail = this.#trail.get(tabId) ?? [];
    return trail.length >= 2 ? trail[trail.length - 2]! : null;
  }

  async goForward(tabId: number): Promise<void> {
    await this.adapter.goForward(tabId);
  }

  async loadProfile(): Promise<UserProfile | null> {
    return loadProfile(this.adapter);
  }

  /**
   * Wait for the result of an action or navigation:
   *  1. with `since`, wait (bounded) until the page differs from it — URL, document or DOM version;
   *  2. then wait until the tab has finished loading and the DOM is quiet.
   */
  async settle(
    tabId: number,
    options: { since: ProbeResponse | null; timeoutMs: number },
  ): Promise<ProbeResponse | null> {
    const deadline = Date.now() + options.timeoutMs;
    const since = options.since;

    if (since) {
      const changeDeadline = Math.min(deadline, Date.now() + CHANGE_WINDOW_MS);
      while (Date.now() < changeDeadline) {
        const tab = await this.adapter.getTab(tabId);
        if (!tab) throw new Error('the agent tab was closed');
        if (tab.status === 'loading' || tab.url !== since.url) break;
        const now = await this.#probeQuietly(tabId);
        if (
          now &&
          (now.documentId !== since.documentId ||
            now.version !== since.version ||
            now.url !== since.url)
        )
          break;
        await sleep(POLL_MS);
      }
    }

    let previous: ProbeResponse | null = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const tab = await this.adapter.getTab(tabId);
      if (!tab) throw new Error('the agent tab was closed');
      if (tab.status === 'complete' && !isWebUrl(tab.url)) return null;
      if (tab.status === 'complete') {
        const current = await this.#probeQuietly(tabId);
        const sameDocument =
          current !== null &&
          previous !== null &&
          current.readyState === 'complete' &&
          current.url === previous.url &&
          current.documentId === previous.documentId;
        if (sameDocument && current.version - previous!.version <= QUIET_MUTATIONS) {
          return current;
        }
        if (!sameDocument) stableSince = Date.now();
        else if (Date.now() - stableSince >= BUSY_PAGE_SETTLED_MS) return current;
        previous = current;
        await sleep(STABLE_INTERVAL_MS);
      } else {
        previous = null;
        stableSince = Date.now();
        await sleep(POLL_MS);
      }
    }
    return this.#probeQuietly(tabId);
  }

  /** Probe that tolerates a document being torn down mid-navigation. */
  async #probeQuietly(tabId: number): Promise<ProbeResponse | null> {
    try {
      return await this.probe(tabId, null);
    } catch {
      return null;
    }
  }
}
