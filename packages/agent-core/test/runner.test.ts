import { DEFAULT_SETTINGS, type Settings } from '@techie-mind/config';
import { Task, TaskResult, type AuditEvent } from '@techie-mind/contracts';
import { createLogger, MemorySink } from '@techie-mind/telemetry';
import { beforeEach, describe, expect, it } from 'vitest';
import { runTask } from '../src/runner.js';
import { FIREWALL_CHECKS } from '@techie-mind/security';
import { clearResolutionCache } from '../src/website.js';
import { VirtualSite, type SiteBehaviour } from './virtual-site.js';

async function run(
  text: string,
  behaviour: SiteBehaviour = {},
  settings: Settings = DEFAULT_SETTINGS,
) {
  const site = new VirtualSite('https://shop.fixture.test', behaviour);
  const sink = new MemorySink(500);
  const task = Task.parse({
    taskId: 'task-1',
    text,
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'unknown',
    status: 'RUNNING',
    createdAt: 0,
    maxSteps: settings.agent.maxSteps,
    skillId: null,
  });
  const result = await runTask(task, {
    host: site,
    logger: createLogger({ component: 'agent', sinks: [sink], level: 'debug' }),
    settings,
  });
  return { result, site, events: sink.events as AuditEvent[] };
}

const types = (events: AuditEvent[]) => events.map((e) => e.type);

describe('runTask — generic pipeline', () => {
  it('navigates, grounds the search field, types, submits and verifies results', async () => {
    const { result, site, events } = await run(
      'open shop.fixture.test and search for trail running shoes',
    );
    expect(TaskResult.safeParse(result).success).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.steps.map((s) => [s.goal, s.verified])).toEqual([
      ['navigate', true],
      ['search', true],
    ]);
    expect(site.url).toBe('https://shop.fixture.test/search?q=trail+running+shoes');
    expect(result.timings.modelCalls).toBe(0);
    for (const t of [
      'TASK_STARTED',
      'INTENT_RESOLVED',
      'TARGET_ROUTED',
      'NAVIGATION_STARTED',
      'OBSERVATION_CREATED',
      'TARGET_GROUNDED',
      'ACTION_PROPOSED',
      'ACTION_ALLOWED',
      'ACTION_EXECUTED',
      'VERIFICATION_COMPLETED',
      'TASK_COMPLETED',
    ]) {
      expect(types(events), t).toContain(t);
    }
  });

  it('handles a different query and wording with no code change', async () => {
    const { result, site } = await run(
      'go to shop.fixture.test and look up waterproof hiking boots',
    );
    expect(result.status).toBe('COMPLETED');
    expect(site.query).toBe('waterproof hiking boots');
  });

  it('never types into the newsletter decoy', async () => {
    const { site } = await run('open shop.fixture.test and search for socks');
    const typed = site.executed.filter((a) => a.args.type === 'TYPE');
    expect(
      typed.every(
        (a) =>
          a.binding.target?.kind === 'element' && a.binding.target.elementId.startsWith('field'),
      ),
    ).toBe(true);
  });

  it('binds every element action to task, observation, document, tab, origin, target and version', async () => {
    const { site } = await run('open shop.fixture.test and search for socks');
    for (const action of site.executed) {
      expect(action.binding).toMatchObject({
        taskId: 'task-1',
        tabId: 1,
        origin: 'https://shop.fixture.test',
      });
      expect(action.binding.observationId).toMatch(/^obs-/);
      expect(action.binding.documentId).toMatch(/^doc-/);
      expect(action.proposedBy).toBe('deterministic');
    }
  });

  it('recovers when Enter does not submit: falls back to the search button (L5)', async () => {
    const { result, site } = await run('open shop.fixture.test and search for trail shoes', {
      implicitSubmit: false,
    });
    expect(result.status).toBe('COMPLETED');
    const search = result.steps.find((s) => s.goal === 'search')!;
    expect(search.recovery.map((r) => [r.level, r.strategy])).toEqual([
      [5, 'alternative-strategy'],
    ]);
    expect(site.executed.some((a) => a.args.type === 'CLICK')).toBe(true);
  });

  it('reveals a collapsed search field via its toggle (L2 refresh, then L5 reveal)', async () => {
    const { result } = await run('open shop.fixture.test and search for trail shoes', {
      collapsed: true,
    });
    expect(result.status).toBe('COMPLETED');
    const levels = result.steps.find((s) => s.goal === 'search')!.recovery.map((r) => r.level);
    expect(levels).toEqual([2, 5]);
  });

  it('re-grounds after the field is re-mounted under it (L3)', async () => {
    const { result, site } = await run('open shop.fixture.test and search for trail shoes', {
      remountOnFirstFocus: true,
    });
    expect(result.status).toBe('COMPLETED');
    expect(
      result.steps.find((s) => s.goal === 'search')!.recovery.map((r) => r.strategy),
    ).toContain('reground');
    const typedTargets = site.executed
      .filter((a) => a.args.type === 'TYPE')
      .map((a) => a.binding.target?.kind === 'element' && a.binding.target.elementId);
    expect(typedTargets).toEqual(['field-0', 'field-1']);
  });

  it('hands over honestly when a page has no search field — never reports success', async () => {
    const { result, events } = await run('open shop.fixture.test and search for trail shoes', {
      noSearch: true,
    });
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/No search field/);
    const search = result.steps.find((s) => s.goal === 'search')!;
    expect(search.verified).toBe(false);
    expect(search.recovery.at(-1)).toMatchObject({ level: 6, strategy: 'handover' });
    expect(types(events)).toContain('HANDOVER_REQUIRED');
    expect(types(events)).not.toContain('TASK_COMPLETED');
  });

  it('opens and verifies a playing result for playback requests', async () => {
    const { result, site } = await run('go to shop.fixture.test and play lo-fi beats', {
      media: true,
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.steps.map((s) => s.goal)).toEqual(['navigate', 'search', 'open-result']);
    expect(site.url).toBe('https://shop.fixture.test/item/1');
  });

  it('stops at the step budget instead of looping', async () => {
    const tight: Settings = {
      ...DEFAULT_SETTINGS,
      agent: { ...DEFAULT_SETTINGS.agent, maxSteps: 2 },
    };
    const { result } = await run(
      'open shop.fixture.test and search for trail shoes',
      { implicitSubmit: false },
      tight,
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('BUDGET_EXCEEDED');
  });

  it('refuses purchases in the agent core rather than improvising', async () => {
    const { result, site } = await run('buy running shoes on flipkart');
    expect(result.status).toBe('FAILED');
    expect(result.error?.code).toBe('UNSUPPORTED_INTENT');
    expect(site.executed).toHaveLength(0);
  });

  it('records per-stage timings', async () => {
    const { result } = await run('open shop.fixture.test and search for socks');
    const t = result.timings;
    expect(t.totalMs).toBeGreaterThan(0);
    expect(t.observations).toBeGreaterThanOrEqual(2);
    for (const k of [
      'intentMs',
      'routeMs',
      'navigationMs',
      'observationMs',
      'groundingMs',
      'actionMs',
      'verificationMs',
      'waitMs',
    ] as const) {
      expect(t[k]).toBeGreaterThanOrEqual(0);
    }
  });
});

async function runOn(site: VirtualSite, text: string, clock?: () => number) {
  const sink = new MemorySink(500);
  const task = Task.parse({
    taskId: `task-${site.navigations.length}-${site.executed.length}`,
    text,
    source: 'typed',
    mode: 'search',
    autonomy: 'act-without-asking',
    language: 'unknown',
    status: 'RUNNING',
    createdAt: 0,
    maxSteps: DEFAULT_SETTINGS.agent.maxSteps,
    skillId: null,
  });
  const result = await runTask(task, {
    host: site,
    logger: createLogger({ component: 'agent', sinks: [sink], level: 'debug' }),
    settings: DEFAULT_SETTINGS,
    ...(clock ? { clock } : {}),
  });
  return { result, events: sink.events as AuditEvent[] };
}

const titled = (title: string) => `<html><head><title>${title}</title></head><body></body></html>`;

describe('runTask — current context, continuity and website resolution (Phase 1 correction)', () => {
  beforeEach(() => clearResolutionCache());

  it('reuses the open tab for an explicit current-tab request — no navigation at all', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', { startOn: 'home' });
    const { result } = await runOn(site, 'In the current tab, search for evening ragas');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual([]);
    expect(result.navigation).toMatchObject({
      targetSource: 'CURRENT_TAB',
      navigationPolicy: 'REUSE_CURRENT_CONTEXT',
      reusedTab: true,
      contextOrigin: 'https://tunes.fixture.test',
    });
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'search']);
    expect(site.query).toBe('evening ragas');
  });

  it('implicitly continues on the open page when it can search (no site named)', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', { startOn: 'home' });
    const { result } = await runOn(site, 'Search for evening ragas.');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual([]);
    expect(result.navigation?.targetSource).toBe('CURRENT_PAGE');
  });

  it('search-and-play on an open media site stays there (F)', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', {
      startOn: 'home',
      mediaHome: true,
      media: true,
    });
    const { result } = await runOn(site, 'Search for evening ragas and play one.');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual([]);
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'search', 'open-result']);
  });

  it('navigates away only when the open page cannot satisfy the request', async () => {
    const site = new VirtualSite('https://article.fixture.test', {
      startOn: 'home',
      noSearch: true,
    });
    const { result } = await runOn(site, 'search for evening ragas');
    expect(result.navigation).toMatchObject({
      targetSource: 'SEARCH_DISCOVERY',
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
      reusedTab: false,
    });
    expect(site.navigations).toEqual(['https://www.google.com/']);
  });

  it("continues a second command in the first command's tab (H)", async () => {
    const site = new VirtualSite('https://tunes.fixture.test');
    const first = await runOn(site, 'open tunes.fixture.test');
    expect(first.result.status).toBe('COMPLETED');
    const second = await runOn(site, 'Search for evening ragas.');
    expect(second.result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual(['https://tunes.fixture.test/']);
    expect(second.result.navigation?.reusedTab).toBe(true);
    expect(site.url).toContain('/search?q=evening+ragas');
  });

  it('plays the Nth result of the current results page without searching again (I)', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', {
      startOn: 'results',
      startQuery: 'evening ragas',
      media: true,
    });
    const { result } = await runOn(site, 'Play the second result.');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual([]);
    expect(site.executed.filter((a) => a.args.type === 'TYPE')).toHaveLength(0);
    expect(site.url).toBe('https://tunes.fixture.test/item/2');
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'open-result']);
  });

  it('adopts the tab a result opens (target=_blank) instead of clicking again (user bug B5)', async () => {
    const site = new VirtualSite('https://shop.fixture.test', {
      startOn: 'results',
      startQuery: 'iphone',
      newTabResults: true,
    });
    const { result } = await runOn(site, 'click the second product');
    expect(result.status, JSON.stringify(result.error)).toBe('COMPLETED');
    // Exactly one click, one new tab, and the agent switched to it — no duplicates.
    expect(site.executed.filter((a) => a.args.type === 'CLICK')).toHaveLength(1);
    expect(site.openedTabs_).toHaveLength(1);
    expect(site.adopted).toEqual([site.openedTabs_[0]!.id]);
    expect(site.url).toBe('https://shop.fixture.test/item/2');
  });

  it('refuses a result reference when there is no open page (never searches the web for it)', async () => {
    const site = new VirtualSite('https://tunes.fixture.test');
    const { result } = await runOn(site, 'play the first one');
    expect(result).toMatchObject({ status: 'FAILED', error: { code: 'NO_RESULTS_CONTEXT' } });
    expect(site.navigations).toEqual([]);
  });

  it('resolves an unknown brand to its website and navigates there directly (A–D)', async () => {
    const site = new VirtualSite('about:blank', {
      websites: {
        'https://lumora.com/': {
          status: 200,
          finalUrl: 'https://www.lumora.com/',
          body: titled('Lumora — Official Store'),
        },
        'https://lumora.in/': { status: 200, body: titled('lumora.in is for sale') },
      },
    });
    const { result, events } = await runOn(site, 'Open Lumora');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual(['https://www.lumora.com/']);
    expect(site.navigations.some((u) => u.includes('google'))).toBe(false);
    expect(result.target).toMatchObject({ domain: 'lumora.com', reason: 'resolved-website' });
    expect(result.navigation).toMatchObject({
      targetSource: 'RESOLVED_WEBSITE',
      navigationPolicy: 'RESOLVE_WEBSITE',
      resolution: { name: 'Lumora', chosen: { domain: 'lumora.com' }, ambiguous: false },
    });
    expect(result.timings.resolutionMs).toBeGreaterThanOrEqual(0);
    expect(events.some((e) => /Resolving website/.test(e.message))).toBe(true);
  });

  it('resolves, navigates and searches in one request ("open X and search for Y")', async () => {
    const site = new VirtualSite('about:blank', {
      websites: {
        'https://lumora.com/': { status: 200, body: titled('Lumora') },
      },
    });
    const { result } = await runOn(site, 'Open Lumora and search for linen shirts');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual(['https://lumora.com/']);
    expect(site.query).toBe('linen shirts');
  });

  it('reuses the tab when it is already on the named website (no probing)', async () => {
    const site = new VirtualSite('https://www.lumora.com', { startOn: 'home' });
    const { result } = await runOn(site, 'Open Lumora and search for linen shirts');
    expect(result.status).toBe('COMPLETED');
    expect(site.probedUrls).toEqual([]);
    expect(site.navigations).toEqual([]);
  });

  it('uses search-engine discovery only as the last resort and hands over honestly', async () => {
    const site = new VirtualSite('about:blank', {});
    const { result } = await runOn(site, 'Open Zzqxv');
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.code).toBe('WEBSITE_NOT_RESOLVED');
    expect(result.navigation).toMatchObject({
      targetSource: 'SEARCH_DISCOVERY',
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
    });
    expect(site.probedUrls.length).toBeGreaterThan(0);
    // Inconclusive background probes → the two likeliest candidates are checked in the tab; the
    // pages there do not name themselves after the brand, so nothing is accepted.
    expect(site.navigations).toEqual([
      'https://zzqxv.com/',
      'https://zzqxv.in/',
      'https://www.google.com/',
    ]);
    expect(
      result.navigation?.resolution?.candidates.find((c) => c.domain === 'zzqxv.com')?.evidence,
    ).toMatch(/does not name itself/);
  });

  it('confirms a candidate in the real tab when background probes are inconclusive (bot walls)', async () => {
    // Every background fetch fails (as bot protection does to non-browser requests), but the
    // browser tab loads the site and it names itself after the brand.
    const site = new VirtualSite('about:blank', { homeTitle: 'Online Shopping — Lumora' });
    const { result } = await runOn(site, 'Open Lumora and search for linen shirts');
    expect(result.status).toBe('COMPLETED');
    expect(site.navigations).toEqual(['https://lumora.com/']);
    expect(result.navigation?.resolution?.chosen?.domain).toBe('lumora.com');
    expect(result.steps.map((s) => s.goal)).toEqual(['use-context', 'search']);
    expect(site.query).toBe('linen shirts');
  });

  it('asks the user instead of guessing when two websites are equally plausible', async () => {
    const site = new VirtualSite('about:blank', {
      websites: {
        'https://orbis.in/': { status: 200, body: titled('Orbis Eyewear India') },
        'https://orbis.org/': { status: 200, body: titled('Orbis — eye-care charity') },
      },
    });
    const { result } = await runOn(site, 'open orbis');
    expect(result).toMatchObject({
      status: 'HUMAN_REQUIRED',
      error: { code: 'AMBIGUOUS_WEBSITE' },
    });
    expect(result.error?.message).toMatch(/orbis\.in/);
    expect(site.navigations).toEqual([]);
  });

  it('caches a resolution: the second request for the same name does not probe again', async () => {
    const site = new VirtualSite('about:blank', {
      websites: { 'https://lumora.com/': { status: 200, body: titled('Lumora') } },
    });
    await runOn(site, 'Open Lumora');
    expect(site.probedUrls.length).toBeGreaterThan(0);
    // A fresh blank tab (not already on the site), same background: answered from the cache.
    const fresh = new VirtualSite('about:blank', {});
    const again = await runOn(fresh, 'go to lumora');
    expect(again.result.navigation?.resolution?.fromCache).toBe(true);
    expect(fresh.probedUrls).toEqual([]);
    expect(fresh.navigations).toEqual(['https://lumora.com/']);
  });

  it('waits out an automatic access check that clears by itself', async () => {
    const site = new VirtualSite('about:blank', { challengeProbes: 2 });
    const { result } = await runOn(site, 'open tunes.fixture.test and search for evening ragas');
    expect(result.status).toBe('COMPLETED');
  });

  it('hands a persistent CAPTCHA / bot wall to the human — never reports success', async () => {
    const site = new VirtualSite('about:blank', { challengeProbes: Number.POSITIVE_INFINITY });
    let t = 0;
    const clock = () => (t += 250); // simulated time: the bounded wait expires without sleeping
    const { result, events } = await runOn(
      site,
      'open tunes.fixture.test and search for ragas',
      clock,
    );
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/human-verification/);
    expect(result.steps[0]).toMatchObject({ goal: 'navigate', verified: false });
    expect(events.map((e) => e.type)).not.toContain('TASK_COMPLETED');
  });
});

describe('runTask — security and privacy in the loop (Phase 2)', () => {
  beforeEach(() => clearResolutionCache());
  const RAW = ['Asha Verma', 'asha.verma@example.com', '98765 43210', '2341 2341 2346'];

  it('runs every action through the firewall and reports the checks passed', async () => {
    const site = new VirtualSite('about:blank');
    const { result, events } = await runOn(site, 'open shop.fixture.test and search for socks');
    expect(result.status).toBe('COMPLETED');
    const allowed = events.filter((e) => e.type === 'ACTION_ALLOWED');
    expect(allowed.length).toBeGreaterThanOrEqual(2); // NAVIGATE + TYPE
    expect(allowed.every((e) => e.data['checks'] === FIREWALL_CHECKS.join(','))).toBe(true);
    expect(result.timings.firewallMs).toBeGreaterThanOrEqual(0);
  });

  it('never follows instructions written in the page (visible lure, hidden text)', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', {
      startOn: 'results',
      startQuery: 'evening ragas',
      injection: true,
      media: true,
    });
    const { result, events } = await runOn(site, 'Play the first result.');
    expect(result.status).toBe('COMPLETED');
    expect(site.url).toBe('https://tunes.fixture.test/item/1');
    expect(site.navigations.some((u) => u.includes('evil'))).toBe(false);
    expect(
      site.executed.some(
        (a) => a.binding.target?.kind === 'element' && a.binding.target.elementId === 'lure',
      ),
    ).toBe(false);
    expect(site.executed.filter((a) => a.args.type === 'TYPE')).toHaveLength(0);
    expect(result.privacy?.injectionsIgnored).toBeGreaterThanOrEqual(2);
    expect(
      events.some((e) => e.type === 'PRIVACY_EVENT' && /instruct the agent/.test(e.message)),
    ).toBe(true);
  });

  it('stops before a payment control and hands over — never clicks it', async () => {
    const site = new VirtualSite('https://tunes.fixture.test', {
      startOn: 'results',
      startQuery: 'premium plan',
      paymentResult: true,
    });
    const { result, events } = await runOn(site, 'open the first result');
    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.error?.message).toMatch(/authorize a payment/);
    expect(site.url).not.toContain('/checkout');
    expect(
      site.executed.some(
        (a) => a.binding.target?.kind === 'element' && a.binding.target.elementId === 'r0',
      ),
    ).toBe(false);
    expect(
      events.some((e) => e.type === 'ACTION_BLOCKED' && e.data['handover'] === 'payment'),
    ).toBe(true);
  });

  it('detects page PII locally, reports only counts, and keeps raw values out of every event', async () => {
    const site = new VirtualSite('about:blank', { pii: true });
    const { result, events } = await runOn(site, 'open shop.fixture.test and search for socks');
    expect(result.status).toBe('COMPLETED');
    expect(result.privacy).toMatchObject({ sentExternally: 0 });
    expect(result.privacy!.detected).toBeGreaterThanOrEqual(4);
    expect(Object.keys(result.privacy!.byKind)).toEqual(
      expect.arrayContaining(['name', 'email', 'phone', 'aadhaar']),
    );
    expect(events.some((e) => e.type === 'PRIVACY_SCAN_COMPLETED')).toBe(true);
    const dump = JSON.stringify({ events, result });
    for (const value of RAW) expect(dump, value).not.toContain(value);
  });
});
