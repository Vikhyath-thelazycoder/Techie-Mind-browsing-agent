import type { BookmarkEntry, BrowserData, SavedPage, TabEntry } from '@techie-mind/agent-core';
import type { BrowserAdapter } from '@techie-mind/browser';
import { Monitor } from '@techie-mind/contracts';

/**
 * Browser data for the Phase 6 skills: bookmarks, tabs/tab groups and downloads through the
 * browser's own APIs; read-later and monitors in extension storage. URLs are stored without query
 * strings or fragments, titles are bounded, nothing else of a page is kept.
 */
export interface BrowserDataApi {
  bookmarks?: {
    search(query: string | { url?: string; query?: string }): Promise<Array<{ id: string; url?: string; title: string }>>;
    create(bookmark: { parentId?: string; title: string; url: string }): Promise<{ id: string; url?: string; title: string }>;
    remove(id: string): Promise<void>;
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string; title?: string; pinned?: boolean; active?: boolean; windowId?: number }>>;
    remove(tabIds: number[]): Promise<void>;
    group?(options: { tabIds: number[]; groupId?: number }): Promise<number>;
  };
  tabGroups?: {
    update(groupId: number, props: { title?: string; collapsed?: boolean }): Promise<unknown>;
  };
  downloads?: {
    download(options: { url: string; filename: string; saveAs?: boolean; conflictAction?: string }): Promise<number>;
  };
}

export const READ_LATER_KEY = 'techieMind.readLater';
export const MONITORS_KEY = 'techieMind.monitors';
const MAX_READ_LATER = 500;
const MAX_MONITORS = 200;

const cleanUrl = (url: string) => url.split(/[?#]/)[0]!.slice(0, 2048);
const safeName = (name: string) =>
  name
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^\.+/, '').slice(0, 80))
    .filter(Boolean)
    .join('/');

export function createBrowserData(api: BrowserDataApi, adapter: BrowserAdapter): BrowserData {
  const readList = async (key: string): Promise<unknown[]> => {
    const stored = await adapter.storageGet(key);
    return Array.isArray(stored) ? stored : [];
  };
  return {
    bookmarks: {
      async search(query) {
        if (!api.bookmarks) return [];
        const found = await api.bookmarks.search(
          /^https?:\/\//.test(query) ? { url: query } : query ? { query } : {},
        );
        return found
          .filter((b): b is { id: string; url: string; title: string } => typeof b.url === 'string')
          .map((b): BookmarkEntry => ({ id: b.id, url: b.url, title: b.title }));
      },
      async add({ url, title }) {
        if (!api.bookmarks) throw new Error('bookmarks are not available');
        const b = await api.bookmarks.create({ url: cleanUrl(url), title: title.slice(0, 300) });
        return { id: b.id, url: b.url ?? cleanUrl(url), title: b.title };
      },
      async remove(id) {
        if (!api.bookmarks) throw new Error('bookmarks are not available');
        await api.bookmarks.remove(id);
      },
    },
    tabs: {
      async list() {
        const tabs = await api.tabs.query({});
        return tabs
          .filter((t) => typeof t.id === 'number')
          .map(
            (t): TabEntry => ({
              id: t.id!,
              url: t.url ?? '',
              title: (t.title ?? '').slice(0, 300),
              pinned: !!t.pinned,
              active: !!t.active,
              windowId: t.windowId ?? 0,
            }),
          );
      },
      async group(tabIds, title) {
        if (!api.tabs.group || !api.tabGroups) return false;
        const groupId = await api.tabs.group({ tabIds });
        await api.tabGroups.update(groupId, { title: title.slice(0, 40) });
        return true;
      },
      async close(tabIds) {
        if (tabIds.length) await api.tabs.remove(tabIds);
      },
    },
    readLater: {
      async add(page: SavedPage) {
        const list = (await readList(READ_LATER_KEY)) as SavedPage[];
        const entry = { url: cleanUrl(page.url), title: page.title.slice(0, 300), savedAt: page.savedAt };
        await adapter.storageSet(
          READ_LATER_KEY,
          [entry, ...list.filter((p) => p.url !== entry.url)].slice(0, MAX_READ_LATER),
        );
      },
      async list() {
        return (await readList(READ_LATER_KEY)) as SavedPage[];
      },
      async remove(url) {
        const list = (await readList(READ_LATER_KEY)) as SavedPage[];
        const next = list.filter((p) => p.url !== cleanUrl(url));
        await adapter.storageSet(READ_LATER_KEY, next);
        return next.length !== list.length;
      },
    },
    monitors: {
      async add(monitor) {
        const parsed = Monitor.parse(monitor);
        const list = await readList(MONITORS_KEY);
        await adapter.storageSet(MONITORS_KEY, [parsed, ...list].slice(0, MAX_MONITORS));
      },
      async list() {
        return (await readList(MONITORS_KEY)).flatMap((m) => {
          const parsed = Monitor.safeParse(m);
          return parsed.success ? [parsed.data] : [];
        });
      },
    },
    async download({ name, mime, content, base64 }) {
      if (!api.downloads) return false;
      const data = base64 ? content : btoa(unescape(encodeURIComponent(content)));
      try {
        await api.downloads.download({
          url: `data:${mime};base64,${data}`,
          filename: safeName(name) || 'techie-mind-file',
          conflictAction: 'uniquify',
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
