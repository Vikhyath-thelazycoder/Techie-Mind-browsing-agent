import {
  elementFingerprint,
  type Action,
  type DOMNode,
  type ExecuteResponse,
  type ExtractedItem,
  type ExtractTextResponse,
  type Observation,
  type ProbeResponse,
  type UserProfile,
  type WebsiteProbe,
} from '@techie-mind/contracts';
import type { AgentHost } from '../src/host.js';
import type { TabContext } from '../src/router.js';

/**
 * A scripted multi-page website for Phase 5 workflow tests: pages are data (nodes, items, text),
 * clicks and typing are handled like the real executor (binding, fingerprint), and every
 * capability the runner may use is recorded so tests can assert what really happened.
 */
export interface PageDef {
  title: string;
  nodes: DOMNode[];
  items?: ExtractedItem[];
  text?: Omit<ExtractTextResponse, 'type' | 'documentId' | 'ms'>;
  /** Clicking these node ids moves to another page (path) or runs a mutation. */
  clicks?: Record<string, string | ((site: WorkflowSite) => void)>;
  /** A search field id: typing + submit opens `/search?q=` of this site. */
  searchField?: string;
  /** Page height in px (for scrolling). */
  height?: number;
}

export const node = (n: Partial<DOMNode> & { nodeId: string; tag: string }): DOMNode => ({
  parentId: null,
  role: n.tag === 'a' ? 'link' : n.tag === 'button' ? 'button' : null,
  name: null,
  text: null,
  attributes: {},
  inputType: null,
  formId: null,
  value: null,
  visible: true,
  interactive: true,
  editable: false,
  bbox: { x: 100, y: 100, width: 300, height: 40 },
  ...n,
});

export class WorkflowSite implements AgentHost {
  path: string;
  doc = 1;
  version = 0;
  scrollY = 0;
  cartCount = 0;
  readonly history: string[] = [];
  readonly forward: string[] = [];
  readonly values = new Map<string, string>();
  readonly executed: Array<{ action: Action; resolved?: { vaultToken: string; text: string } }> = [];
  readonly trusted: string[] = [];
  readonly navigations: string[] = [];
  mediaClock = 0;
  /** A trusted gesture happened in this document (what unlocks sound autoplay in Chrome). */
  activated = false;

  /** Other websites reachable by navigation (origin → pages), e.g. a second store. */
  readonly others: Record<string, Record<string, PageDef | ((query: string) => PageDef)>> = {};
  readonly home: string;

  constructor(
    public origin: string,
    public pages: Record<string, PageDef | ((query: string) => PageDef)>,
    start: string,
    readonly profile: UserProfile | null = null,
    readonly options: {
      trustedInput?: boolean;
      /** Item pages hold a video that plays only after a trusted click (Chrome's autoplay rule). */
      media?: boolean;
    } = {},
  ) {
    this.path = start;
    this.home = origin;
    this.others[origin] = pages;
  }

  /** Add another website the agent may navigate to. */
  addSite(origin: string, pages: Record<string, PageDef | ((query: string) => PageDef)>) {
    this.others[origin] = pages;
    return this;
  }

  get url() {
    return `${this.origin}${this.path}`;
  }

  page(): PageDef {
    const [path, qs] = this.path.split('?');
    const def = this.pages[path!];
    if (!def) throw new Error(`no page ${path}`);
    return typeof def === 'function' ? def(new URLSearchParams(qs ?? '').get('q') ?? '') : def;
  }

  go(path: string) {
    this.history.push(`${this.origin}|${this.path}`);
    this.forward.length = 0;
    this.path = path;
    this.doc += 1;
    this.version = 0;
    this.scrollY = 0;
    this.values.clear();
  }

  async currentContext(): Promise<TabContext> {
    const u = new URL(this.url);
    return { tabId: 1, url: this.url, origin: u.origin, host: u.hostname, title: this.page().title, source: 'active-tab' };
  }
  async prepareTab() {
    return 1;
  }
  async navigate(_t: number, url: string) {
    this.navigations.push(url);
    const u = new URL(url);
    const pages = this.others[u.origin];
    if (!pages) throw new Error(`unknown site ${u.origin}`);
    this.origin = u.origin;
    this.pages = pages;
    this.go(u.pathname + u.search);
  }
  #restore(entry: string) {
    const [origin, path] = entry.split('|') as [string, string];
    this.origin = origin;
    this.pages = this.others[origin]!;
    this.path = path;
    this.doc += 1;
  }
  async goBack() {
    const prev = this.history.pop();
    if (!prev) return;
    this.forward.push(`${this.origin}|${this.path}`);
    this.#restore(prev);
  }
  async goForward() {
    const next = this.forward.pop();
    if (!next) return;
    this.history.push(`${this.origin}|${this.path}`);
    this.#restore(next);
  }
  region() {
    return 'IN';
  }
  async probeWebsites(urls: readonly string[]): Promise<WebsiteProbe[]> {
    return urls.map((url) => ({ url, status: null, finalUrl: null, body: '', error: 'ENOTFOUND', ms: 1 }));
  }

  #nodes(): DOMNode[] {
    return this.page().nodes.map((n) => (n.editable || n.tag === 'select' ? { ...n, value: this.values.get(n.nodeId) ?? '' } : n));
  }

  async observe(tabId: number, taskId: string, observationId: string): Promise<Observation> {
    return {
      observationId,
      taskId,
      tabId,
      documentId: `doc-${this.doc}`,
      origin: this.origin,
      url: this.url,
      title: this.page().title,
      version: this.version,
      createdAt: 0,
      viewport: { width: 1280, height: 800, scrollX: 0, scrollY: this.scrollY, devicePixelRatio: 1 },
      domNodes: this.#nodes(),
      a11yNodes: [],
      visualRegions: [],
    };
  }

  #reply(action: Action, status: ExecuteResponse['status'], code: ExecuteResponse['code'], valueAfter: string | null = null): ExecuteResponse {
    return { type: 'EXECUTE_RESULT', actionId: action.actionId, status, code, message: code ?? 'ok', valueAfter, versionAfter: this.version, deferred: false };
  }

  async execute(_t: number, action: Action, resolved?: { vaultToken: string; text: string }): Promise<ExecuteResponse> {
    this.executed.push({ action, ...(resolved ? { resolved } : {}) });
    if (action.binding.documentId !== `doc-${this.doc}`) return this.#reply(action, 'rejected', 'DOCUMENT_MISMATCH');
    const t = action.binding.target;
    const n = t?.kind === 'element' ? this.#nodes().find((x) => x.nodeId === t.elementId) : undefined;
    if (t && !n) return this.#reply(action, 'rejected', 'TARGET_MISSING');
    if (n && t?.kind === 'element' && t.fingerprint !== elementFingerprint(n.tag, n.role, n.name)) {
      return this.#reply(action, 'rejected', 'TARGET_CHANGED');
    }
    const a = action.args;
    if (a.type === 'TYPE' && n) {
      const text = 'text' in a.input ? a.input.text : resolved?.vaultToken === a.input.vaultToken ? resolved.text : null;
      if (text === null) return this.#reply(action, 'rejected', 'UNSUPPORTED_ACTION');
      this.values.set(n.nodeId, text);
      this.version += 1;
      if (a.submit && this.page().searchField === n.nodeId) this.go(`/search?q=${encodeURIComponent(text)}`);
      return this.#reply(action, 'executed', null, text);
    }
    if (a.type === 'SELECT' && n) {
      this.values.set(n.nodeId, a.value);
      return this.#reply(action, 'executed', null, a.value);
    }
    if (a.type === 'SCROLL') {
      const max = Math.max(0, (this.page().height ?? 800) - 800);
      this.scrollY = Math.max(0, Math.min(max, this.scrollY + (a.direction === 'up' ? -640 : 640)));
      return this.#reply(action, 'executed', null);
    }
    if (a.type === 'CLICK' && n) {
      this.#click(n.nodeId);
      return this.#reply(action, 'executed', null);
    }
    return this.#reply(action, 'rejected', 'UNSUPPORTED_ACTION');
  }

  #click(id: string) {
    const target = this.page().clicks?.[id];
    if (typeof target === 'string') this.go(target);
    else if (target) {
      target(this);
      this.version += 1;
    }
  }

  async trustedClick(_t: number, elementId: string): Promise<boolean> {
    if (!this.options.trustedInput) return false;
    this.trusted.push(elementId);
    this.#click(elementId);
    this.activated = true;
    return true;
  }

  async probe(): Promise<ProbeResponse> {
    return {
      type: 'PROBE_RESULT',
      url: this.url,
      origin: this.origin,
      title: this.page().title,
      documentId: `doc-${this.doc}`,
      version: this.version,
      readyState: 'complete',
      element: null,
      media: (() => {
        const present = !!this.options.media && this.path.startsWith('/p/');
        const playing = present && this.activated;
        if (playing) this.mediaClock += 1;
        return { present, playing, currentTime: present ? this.mediaClock : null };
      })(),
    };
  }
  async settle() {
    return this.probe();
  }
  async extractItems() {
    return { type: 'ITEMS_RESULT' as const, documentId: `doc-${this.doc}`, items: this.page().items ?? [], ms: 1 };
  }
  async extractText() {
    const text = this.page().text;
    return text ? { type: 'TEXT_RESULT' as const, documentId: `doc-${this.doc}`, ms: 1, ...text } : null;
  }
  async loadProfile() {
    return this.profile;
  }
}
