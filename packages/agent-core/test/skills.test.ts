import { Skill, type Monitor, type SkillId } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import type { BookmarkEntry, BrowserData, SavedPage, TabEntry } from '../src/host.js';
import { resolveIntent } from '../src/intent.js';
import { detectSkill, SKILL_IDS, SKILLS } from '../src/skills.js';
import { node, type PageDef } from './workflow-site.js';
import { product, results, run, shop } from './shop-fixture.js';

/** In-memory browser data: what the skills did is read back from here. */
class FakeData implements BrowserData {
  marks: Array<{ box: unknown; label: string }> = [];
  bookmarkList: BookmarkEntry[] = [];
  tabList: TabEntry[] = [];
  grouped: Array<{ ids: number[]; title: string }> = [];
  saved: SavedPage[] = [];
  monitorList: Monitor[] = [];
  downloads: Array<{ name: string; mime: string; content: string; base64?: boolean }> = [];
  bookmarks = {
    search: async (q: string) =>
      this.bookmarkList.filter(
        (b) => !q || b.url.startsWith(q) || b.title.toLowerCase().includes(q.toLowerCase()),
      ),
    add: async (e: { url: string; title: string }) => {
      const b = { id: `b${this.bookmarkList.length + 1}`, ...e };
      this.bookmarkList.push(b);
      return b;
    },
    remove: async (id: string) => {
      this.bookmarkList = this.bookmarkList.filter((b) => b.id !== id);
    },
  };
  tabs = {
    list: async () => this.tabList,
    group: async (ids: number[], title: string) => {
      this.grouped.push({ ids, title });
      return true;
    },
    close: async (ids: number[]) => {
      this.tabList = this.tabList.filter((t) => !ids.includes(t.id));
    },
  };
  readLater = {
    add: async (p: SavedPage) => {
      this.saved = [p, ...this.saved.filter((x) => x.url !== p.url)];
    },
    list: async () => this.saved,
    remove: async (url: string) => {
      const before = this.saved.length;
      this.saved = this.saved.filter((x) => x.url !== url);
      return this.saved.length !== before;
    },
  };
  monitors = {
    add: async (m: Monitor) => {
      this.monitorList.push(m);
    },
    list: async () => this.monitorList,
  };
  download = async (f: { name: string; mime: string; content: string; base64?: boolean }) => {
    this.downloads.push(f);
    return true;
  };
}

function withData(site: ReturnType<typeof shop>) {
  const data = new FakeData();
  Object.assign(site, {
    browserData: data,
    captureVisible: async (
      _t: number,
      o: { people: boolean; marks?: Array<{ box: unknown; label: string }> },
    ) => {
      data.marks = o.marks ?? [];
      return {
        image: {
          base64: 'iVBORw0KGgo=',
          width: 1008,
          height: 630,
          redacted: true as const,
          regions: 2,
        },
        scale: 0.7875,
        scrollX: 0,
        scrollY: 0,
        ms: 3,
      };
    },
  });
  return data;
}

const SAMPLE: Record<SkillId, string> = {
  'summarize-page': 'summarize this page',
  'deep-research': 'research budget laptops',
  'extract-data': 'extract the data as csv',
  'compare-prices': 'compare laptop prices on store.fixture.test and mart.fixture.test',
  'fill-form': 'fill this form using my saved profile',
  'find-alternatives': 'find alternatives to Dell Inspiron 15 under ₹50,000',
  'manage-bookmarks': 'bookmark this page',
  'monitor-page': 'monitor this product until the price drops below ₹40,000',
  'organize-tabs': 'organize my tabs',
  'read-later': 'save this for later',
  'save-page': 'save this page',
  'screenshot-walkthrough': 'take a screenshot walkthrough',
};

describe('skill matrix', () => {
  it('12 manifests: valid Skill contracts with inputs, risk, permissions, verification and failure handling', () => {
    expect(SKILL_IDS).toHaveLength(12);
    for (const id of SKILL_IDS) {
      const s = SKILLS[id];
      expect(Skill.safeParse(s).success, id).toBe(true);
      expect(s.verification.length, id).toBeGreaterThan(20);
      expect(s.failureHandling.length, id).toBeGreaterThan(20);
      expect(s.permissions.length, id).toBeGreaterThan(0);
    }
  });

  it('every skill is recognised from natural wording and from /skill-id', () => {
    for (const id of SKILL_IDS) {
      const profile = resolveIntent(SAMPLE[id]).profile;
      const recognised =
        profile.entities.find((e) => e.type === 'skill')?.value ??
        (profile.action === 'summarize'
          ? 'summarize-page'
          : profile.action === 'fill_form'
            ? 'fill-form'
            : null);
      expect(recognised, SAMPLE[id]).toBe(id);
      expect(detectSkill(`/${id}`)?.id, id).toBe(id);
    }
    expect(detectSkill('/not-a-skill')).toBeNull();
  });
});

describe('skills — page', () => {
  it('extract-data: items from the page, exported as CSV through the browser download', async () => {
    const site = shop();
    const data = withData(site);
    const { result } = await run(site, 'extract the data as csv');
    expect(result.status).toBe('COMPLETED');
    expect(result.output?.kind).toBe('items');
    expect(data.downloads[0]?.name).toMatch(/TechieMind\/shop\.fixture\.test-data\.csv$/);
    expect(data.downloads[0]?.content.split('\n')[0]).toBe('"title","price","currency","rating"');
    expect(data.downloads[0]?.content).toContain('"HP 255 G9 laptop","34990","INR","3.9"');
  });

  it('extract-data: a table when there are no items; nothing invented when there is neither', async () => {
    const tablePage: PageDef = {
      title: 'Fees',
      nodes: [node({ nodeId: 'h', tag: 'h1', role: 'heading', name: 'Fees', interactive: false })],
      text: {
        title: 'Fees',
        headings: ['Fees'],
        paragraphs: [],
        tables: [
          {
            headers: ['Plan', 'Fee'],
            rows: [
              ['Basic', '₹99'],
              ['Pro', '₹299'],
            ],
          },
        ],
        truncated: false,
      },
    };
    const site = shop('/fees');
    site.pages['/fees'] = tablePage;
    withData(site);
    const { result } = await run(site, 'extract the table');
    expect(result.output).toMatchObject({
      kind: 'list',
      entries: ['Plan | Fee', 'Basic | ₹99', 'Pro | ₹299'],
    });
    const empty = shop('/news');
    withData(empty);
    const { result: none } = await run(empty, 'extract the data');
    expect(none.status).toBe('HUMAN_REQUIRED');
  });

  it('"export the table as csv" exports the TABLE even when the page also has links (live Wikipedia)', async () => {
    // Live on the Mac: a Wikipedia list page has hundreds of links (read as items) and one data
    // table; the CSV came out as link titles ("title","price",…) instead of the table.
    const site = shop('/states');
    site.pages['/states'] = {
      title: 'States by population',
      nodes: [
        node({ nodeId: 'a1', tag: 'a', name: 'Uttar Pradesh', attributes: { href: '/wiki/UP' } }),
        node({ nodeId: 'a2', tag: 'a', name: 'Maharashtra', attributes: { href: '/wiki/MH' } }),
      ],
      items: [
        {
          elementId: 'a1',
          title: 'Uttar Pradesh',
          price: null,
          currency: null,
          rating: null,
          position: 1,
        },
        {
          elementId: 'a2',
          title: 'Maharashtra',
          price: null,
          currency: null,
          rating: null,
          position: 2,
        },
      ],
      text: {
        title: 'States by population',
        headings: [],
        paragraphs: [],
        tables: [
          // A small summary box comes first on the live page; "the table" is the data table.
          { headers: ['Total', 'India'], rows: [['Population', '1,210,854,977']] },
          {
            headers: ['Rank', 'State', 'Population'],
            rows: [
              ['1', 'Uttar Pradesh', '199,812,341'],
              ['2', 'Maharashtra', '112,374,333'],
            ],
          },
        ],
        truncated: false,
      },
    };
    const data = withData(site);
    const { result } = await run(site, 'export the table as csv');
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    expect(data.downloads[0]?.content.split('\n')[0]).toBe('"Rank","State","Population"');
    expect(data.downloads[0]?.content).toContain('"1","Uttar Pradesh","199,812,341"');
  });

  it('screenshot-walkthrough: redacted capture with numbered marks, saved, steps listed', async () => {
    const site = shop();
    const data = withData(site);
    const { result } = await run(site, 'take a screenshot walkthrough');
    expect(result.status).toBe('COMPLETED');
    expect(data.marks.length).toBeGreaterThanOrEqual(3);
    expect(data.marks.map((m) => m.label)).toEqual(data.marks.map((_, i) => String(i + 1)));
    expect(data.downloads[0]).toMatchObject({ mime: 'image/png', base64: true });
    if (result.output?.kind !== 'list') throw new Error('no list');
    {
      expect(result.output.entries[0]).toMatch(
        /^1\. Search for products \(searchbox\) — type here/,
      );
      expect(result.output.entries.at(-1)).toMatch(/2 sensitive region\(s\) were painted over/);
    }
  });

  it('save-page: Markdown download, personal data replaced by placeholders', async () => {
    const site = shop('/news');
    const data = withData(site);
    const { result } = await run(site, 'save this page');
    expect(result.status).toBe('COMPLETED');
    const file = data.downloads[0]!;
    expect(file.name).toBe('TechieMind/monsoon-arrives-in-kerala.md');
    expect(file.content).toMatch(/^# Monsoon arrives in Kerala/);
    expect(file.content).toContain('Source: https://shop.fixture.test/news');
    expect(file.content).not.toMatch(/asha\.verma@example\.com|98765 43210/);
  });
});

describe('skills — multi-source', () => {
  function mart(q: string): PageDef {
    const page = results(q);
    const items = (page.items ?? []).map((i) => ({
      ...i,
      price: i.price! + (i.title.startsWith('HP') ? -2000 : 3000),
    }));
    return { ...page, title: `${q} - Mart`, items };
  }

  it('compare-prices: searches both stores, cheapest matching item per store, never invented', async () => {
    const site = shop('/');
    site.addSite('https://store.fixture.test', { '/': site.pages['/']!, '/search': results });
    site.addSite('https://mart.fixture.test', { '/': site.pages['/']!, '/search': mart });
    const { result } = await run(
      site,
      'compare hp laptop prices on store.fixture.test and mart.fixture.test',
    );
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual(['https://store.fixture.test/', 'https://mart.fixture.test/']);
    expect(result.output?.kind).toBe('items');
    if (result.output?.kind !== 'items') throw new Error('no items');
    {
      expect(result.output.items.map((i) => [i.source, i.price])).toEqual([
        ['mart.fixture.test', 32990],
        ['store.fixture.test', 34990],
      ]);
      expect(result.output.title).toMatch(/Cheapest "hp laptop": ₹32,990 on mart\.fixture\.test/);
    }
  });

  it('compare-prices: a store without a matching item is reported, not estimated', async () => {
    const site = shop('/');
    site.addSite('https://store.fixture.test', { '/': site.pages['/']!, '/search': results });
    site.addSite('https://mart.fixture.test', {
      '/': site.pages['/']!,
      '/search': (q) => ({ ...results(q), items: [] }),
    });
    const { result } = await run(
      site,
      'compare hp laptop prices on store.fixture.test and mart.fixture.test',
    );
    if (result.output?.kind !== 'items') throw new Error('no items');
    {
      expect(result.output.items.map((i) => i.source)).toEqual(['store.fixture.test']);
      expect(result.output.title).toMatch(/no matching price on mart\.fixture\.test/);
    }
  });

  it('find-alternatives: excludes the item itself and applies the budget', async () => {
    const site = shop('/');
    const { result } = await run(site, 'find alternatives to Dell Inspiron 15 under ₹50,000');
    expect(result.status).toBe('COMPLETED');
    if (result.output?.kind !== 'items') throw new Error('no items');
    {
      expect(result.output.items.map((i) => i.title)).toEqual([
        'Lenovo IdeaPad Slim 3 laptop',
        'HP 255 G9 laptop',
      ]);
    }
  });

  it('deep-research: opens several sources, extracts evidence, cites every bullet', async () => {
    const site = shop('/');
    site.addSite('https://shop.fixture.test', {
      ...site.pages,
      '/p/1': product(1),
      '/p/2': product(2),
      '/p/3': product(3),
    });
    const { result } = await run(site, 'research laptops on shop.fixture.test');
    expect(result.status).toBe('COMPLETED');
    expect(result.output).toMatchObject({ kind: 'text', source: 'extractive' });
    if (result.output?.kind !== 'text') throw new Error('no text');
    {
      expect(result.output.text).toMatch(/\[1\][\s\S]*\[2\][\s\S]*\[3\]/);
      expect(result.output.text).toMatch(/Sources:\n\[1\] shop\.fixture\.test\/p\/1/);
    }
    expect(result.steps.filter((s) => s.goal === 'open-element')).toHaveLength(3);
  });
});

describe('skills — browser data', () => {
  it('manage-bookmarks: add (read back, no query string), no duplicate, search, remove exactly one', async () => {
    const site = shop('/p/1');
    const data = withData(site);
    const { result } = await run(site, 'bookmark this page');
    expect(result.status).toBe('COMPLETED');
    expect(data.bookmarkList).toEqual([
      { id: 'b1', url: 'https://shop.fixture.test/p/1', title: 'Product 1 - Shop' },
    ]);
    await run(site, 'bookmark this page');
    expect(data.bookmarkList).toHaveLength(1);
    const { result: search } = await run(site, 'show my bookmarks for product');
    expect(search.output).toMatchObject({
      kind: 'list',
      entries: ['Product 1 - Shop — https://shop.fixture.test/p/1'],
    });
    const { result: removed } = await run(site, 'remove this bookmark');
    expect(removed.status).toBe('COMPLETED');
    expect(data.bookmarkList).toEqual([]);
  });

  it('monitor-page: stores a price-below monitor with the current baseline; https only', async () => {
    const site = shop('/p/2');
    site.origin = 'https://shop.fixture.test';
    const data = withData(site);
    const { result } = await run(site, 'monitor this product until the price drops below ₹30,000');
    expect(result.status).toBe('COMPLETED');
    expect(data.monitorList[0]).toMatchObject({
      url: 'https://shop.fixture.test/p/2',
      condition: { kind: 'price-below', threshold: 30000, currency: 'INR' },
      status: 'active',
    });
    if (result.output?.kind !== 'list') throw new Error('no list');
    expect(result.output.entries.join(' ')).toMatch(/Price now: ₹34,990/);
  });

  it('organize-tabs: groups by site; closes only duplicate copies, never pinned or active', async () => {
    const site = shop();
    const data = withData(site);
    const t = (id: number, url: string, extra: Partial<TabEntry> = {}): TabEntry => ({
      id,
      url,
      title: url,
      pinned: false,
      active: false,
      windowId: 1,
      ...extra,
    });
    data.tabList = [
      t(1, 'https://a.example/x'),
      t(2, 'https://a.example/x', { active: true }),
      t(3, 'https://a.example/y'),
      t(4, 'https://b.example/z', { pinned: true }),
      t(5, 'https://b.example/z', { pinned: true }),
      t(6, 'chrome://settings'),
    ];
    const { result } = await run(site, 'organize my tabs');
    expect(result.status).toBe('COMPLETED');
    expect(data.grouped).toEqual([{ ids: [1, 2, 3], title: 'a.example' }]);
    await run(site, 'close duplicate tabs');
    expect(data.tabList.map((x) => x.id)).toEqual([2, 3, 4, 5, 6]);
  });

  it('read-later: add (address and title only), list, remove', async () => {
    const site = shop('/search?q=laptops');
    const data = withData(site);
    await run(site, 'save this for later');
    expect(data.saved).toEqual([
      {
        url: 'https://shop.fixture.test/search',
        title: 'laptops - Shop',
        savedAt: expect.any(Number),
      },
    ]);
    const { result } = await run(site, 'show my reading list');
    expect(result.output).toMatchObject({ kind: 'list', title: '1 page(s) to read later' });
    await run(site, 'remove this from my reading list');
    expect(data.saved).toEqual([]);
  });
});
