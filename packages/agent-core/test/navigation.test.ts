import { describe, expect, it } from 'vitest';
import { resolveIntent } from '../src/intent.js';
import { planGoals } from '../src/plan.js';
import {
  decideNavigation,
  needsContextFit,
  type ContextFit,
  type TabContext,
} from '../src/router.js';

/**
 * Navigation policy (Phase 1 correction): where a task acts is decided from the wording AND the
 * open tab, before any navigation. Each rule is proven with several wordings (acceptance J).
 */

function tab(url: string): TabContext {
  const u = new URL(url);
  return { tabId: 7, url, origin: u.origin, host: u.hostname, title: 'Page', source: 'active-tab' };
}
const YOUTUBE = tab('https://www.youtube.com/watch?v=abc');
const STORE = tab('https://www.zara.com/in/en/');
const ARTICLE = tab('https://blog.example.org/post/1');
const SEARCHABLE: ContextFit = { canSearch: true, hasMedia: false };
const MEDIA: ContextFit = { canSearch: true, hasMedia: true };
const NO_SEARCH: ContextFit = { canSearch: false, hasMedia: false };

function decide(text: string, context: TabContext | null, fit: ContextFit | null = null) {
  const { profile } = resolveIntent(text);
  const decision = decideNavigation(profile, context, fit);
  return { profile, decision };
}

describe('intent: context-aware fields (targetSource / navigationPolicy)', () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    // Arbitrary website names → RESOLVE_WEBSITE, never a Google query (A–D + J wordings).
    ['Open Zara.', { siteName: 'Zara', navigationPolicy: 'RESOLVE_WEBSITE', query: null }],
    ['Open Snitch', { siteName: 'Snitch', targetSource: 'RESOLVED_WEBSITE' }],
    ['Open Myntra', { siteName: 'Myntra', intent: 'navigate' }],
    ['Open Nike', { siteName: 'Nike', action: 'navigate' }],
    ['Open Reddit', { siteName: 'Reddit' }],
    ['take me to the Myntra website', { siteName: 'Myntra', query: null }],
    ["go to nike's site", { siteName: 'nike' }],
    ['please visit the official Snitch website', { siteName: 'Snitch' }],
    ['Zara kholo', { siteName: 'Zara', language: 'hinglish' }],
    ['Snitch website open maadi', { siteName: 'Snitch', language: 'mixed' }],
    ['launch reddit', { siteName: 'reddit' }],
    [
      'Open Zara and search for black shirts',
      { siteName: 'Zara', query: 'black shirts', action: 'search' },
    ],
    ['search for black shirts on Zara', { siteName: 'Zara', query: 'black shirts' }],
    [
      'search for linen trousers on the zara website',
      { siteName: 'zara', query: 'linen trousers' },
    ],
    ['Zara pe black shirts dhoondo', { siteName: 'Zara', query: 'black shirts' }],
    // Explicit current tab (E + J).
    [
      'In the current tab, search for Hindi songs.',
      {
        targetSource: 'CURRENT_TAB',
        navigationPolicy: 'REUSE_CURRENT_CONTEXT',
        query: 'Hindi songs',
      },
    ],
    ['search here for Hindi songs', { targetSource: 'CURRENT_TAB', query: 'Hindi songs' }],
    ['search Hindi songs on this page', { targetSource: 'CURRENT_TAB', query: 'Hindi songs' }],
    ['on this website, look up ghazals', { targetSource: 'CURRENT_TAB', query: 'ghazals' }],
    [
      'use this tab and find punjabi songs',
      { targetSource: 'CURRENT_TAB', query: 'punjabi songs' },
    ],
    ['continue here and search for red sneakers', { targetSource: 'CURRENT_TAB' }],
    ['isi tab mein bhajans search karo', { targetSource: 'CURRENT_TAB', query: 'bhajans' }],
    // No site named → CURRENT_PAGE proposal (F, G, H + J).
    [
      'Search for Hindi songs and play one.',
      {
        targetSource: 'CURRENT_PAGE',
        action: 'search_and_play',
        query: 'Hindi songs',
        ordinal: null,
      },
    ],
    ['look up hindi songs, then play the first one', { action: 'search_and_play', ordinal: 1 }],
    ['Search for black shirts.', { targetSource: 'CURRENT_PAGE', query: 'black shirts' }],
    ['find me some white sneakers', { targetSource: 'CURRENT_PAGE', query: 'white sneakers' }],
    // Result references (I + J).
    ['Play the first result.', { action: 'play_result', ordinal: 1, query: null }],
    ['play the second one', { action: 'play_result', ordinal: 2 }],
    ['open the 3rd video', { action: 'open_result', ordinal: 3 }],
    ['click on the first link', { action: 'open_result', ordinal: 1 }],
    ['play it', { action: 'play_result', ordinal: null }],
    ['pehla wala chalao', { action: 'play_result', ordinal: 1 }],
    ['modalane video play maadi', { action: 'play_result', ordinal: 1 }],
    // Named/known sites stay explicit and direct.
    ['Open YouTube.', { targetDomain: 'youtube.com', navigationPolicy: 'DIRECT_NAVIGATE' }],
    ['Search YouTube for Kannada songs.', { targetDomain: 'youtube.com', query: 'Kannada songs' }],
    ['open example.org', { targetDomain: 'example.org', targetSource: 'EXPLICIT_USER_TARGET' }],
  ];

  it.each(CASES)('%s', (text, want) => {
    expect(resolveIntent(text).profile).toMatchObject(want);
  });

  it('never turns a query into a site name or a site name into a query', () => {
    expect(resolveIntent('play one direction songs').profile).toMatchObject({
      action: 'search_and_play',
      query: 'one direction songs',
      ordinal: null,
    });
    expect(resolveIntent('search for here comes the sun').profile.query).toBe('here comes the sun');
    expect(resolveIntent('Open YouTube and play some Kannada songs').profile).toMatchObject({
      action: 'search_and_play',
      query: 'Kannada songs',
    });
    expect(resolveIntent('find hotels in goa').profile.siteName).toBeNull();
  });

  it('refuses "open" requests whose object is not a website instead of web-searching them', () => {
    for (const text of ['open a new tab', 'open settings']) {
      expect(resolveIntent(text).profile.intent, text).toBe('unknown');
    }
  });
});

describe('decideNavigation — priority order', () => {
  it('1: explicit current-tab requests reuse the tab and never navigate (E)', () => {
    for (const text of [
      'In the current tab, search for Hindi songs.',
      'search here for devotional songs',
      'on this page search for bhajans',
    ]) {
      const { decision } = decide(text, YOUTUBE, null);
      expect(decision, text).toMatchObject({
        ok: true,
        targetSource: 'CURRENT_TAB',
        navigationPolicy: 'REUSE_CURRENT_CONTEXT',
        reuse: true,
        target: { domain: 'www.youtube.com', reason: 'current-tab' },
      });
    }
  });

  it('1: explicit current-tab request with no web tab fails honestly (no Google)', () => {
    const { decision } = decide('In the current tab, search for Hindi songs.', null);
    expect(decision).toMatchObject({ ok: false, code: 'CURRENT_TAB_UNAVAILABLE' });
  });

  it('1+2: "in this tab, open <site>" navigates the current tab itself', () => {
    const { decision } = decide('in this tab open github', ARTICLE);
    expect(decision).toMatchObject({
      ok: true,
      navigationPolicy: 'DIRECT_NAVIGATE',
      inContextTab: true,
      reuse: false,
    });
  });

  it('2/3: an explicit site already open is reused, otherwise navigated to directly', () => {
    expect(decide('Search YouTube for Kannada songs.', YOUTUBE).decision).toMatchObject({
      reuse: true,
      targetSource: 'EXPLICIT_USER_TARGET',
    });
    expect(decide('Open YouTube', YOUTUBE).decision).toMatchObject({ reuse: true });
    expect(decide('Open YouTube', ARTICLE).decision).toMatchObject({
      reuse: false,
      navigationPolicy: 'DIRECT_NAVIGATE',
      target: { url: 'https://www.youtube.com/' },
    });
  });

  it('3: an unknown website name is resolved — not searched — unless we are already on it', () => {
    for (const text of ['Open Zara.', 'Open Snitch', 'take me to the Myntra website']) {
      const { decision } = decide(text, ARTICLE);
      expect(decision, text).toMatchObject({
        ok: true,
        navigationPolicy: 'RESOLVE_WEBSITE',
        targetSource: 'RESOLVED_WEBSITE',
        target: null,
      });
      expect(decision.ok && decision.resolveName).toBeTruthy();
    }
    expect(decide('Open Zara', STORE).decision).toMatchObject({ reuse: true });
  });

  it('4: no site named — the open page is reused when it can satisfy the request (F, G, H)', () => {
    expect(decide('Search for Hindi songs and play one.', YOUTUBE, MEDIA).decision).toMatchObject({
      reuse: true,
      targetSource: 'CURRENT_PAGE',
    });
    expect(decide('Search for black shirts.', STORE, SEARCHABLE).decision).toMatchObject({
      reuse: true,
      target: { domain: 'www.zara.com' },
    });
    expect(decide('look for running shoes', STORE, SEARCHABLE).decision).toMatchObject({
      reuse: true,
    });
  });

  it('4→5: a playback request on a non-media page goes to the default media site', () => {
    expect(decide('play hindi songs', STORE, SEARCHABLE).decision).toMatchObject({
      reuse: false,
      targetSource: 'RESOLVED_WEBSITE',
      navigationPolicy: 'DIRECT_NAVIGATE',
      target: { domain: 'youtube.com' },
    });
  });

  it('6: a search engine only when the open page cannot search, or no page is open', () => {
    expect(decide('search for black shirts', ARTICLE, NO_SEARCH).decision).toMatchObject({
      targetSource: 'SEARCH_DISCOVERY',
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
      target: { domain: 'google.com' },
    });
    expect(decide('search for black shirts', null).decision).toMatchObject({
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
    });
  });

  it('result references use the current results page and never navigate (I)', () => {
    for (const text of ['Play the first result.', 'open the second video', 'play it']) {
      expect(decide(text, YOUTUBE).decision, text).toMatchObject({
        reuse: true,
        targetSource: 'CURRENT_PAGE',
      });
    }
    expect(decide('Play the first result.', null).decision).toMatchObject({
      ok: false,
      code: 'NO_RESULTS_CONTEXT',
    });
  });

  it('plans reuse without a navigation goal, and result references as open-result', () => {
    const { profile, decision } = decide(
      'Search for Hindi songs and play the first one',
      YOUTUBE,
      MEDIA,
    );
    expect(decision.ok && decision.target).toBeTruthy();
    const plan = decision.ok && decision.target ? planGoals(profile, decision.target, true) : null;
    expect(plan).toMatchObject({
      ok: true,
      goals: [
        { kind: 'use-context', domain: 'www.youtube.com' },
        { kind: 'search', query: 'Hindi songs' },
        { kind: 'open-result', media: true, ordinal: 1 },
      ],
    });
    const follow = decide('Play the first result.', YOUTUBE);
    const followPlan =
      follow.decision.ok && follow.decision.target
        ? planGoals(follow.profile, follow.decision.target, true)
        : null;
    expect(followPlan).toMatchObject({
      goals: [{ kind: 'use-context' }, { kind: 'open-result', query: null, ordinal: 1 }],
    });
  });

  it('never records the open page query string in the target (privacy)', () => {
    const withQuery = tab('https://www.example.com/account?email=a%40b.c&token=xyz');
    const { decision } = decide('search here for invoices', withQuery);
    expect(decision.ok && decision.target?.url).toBe('https://www.example.com/account');
  });
});

/**
 * Bugs the user hit in their own Chrome (2026-09-28), with their wording. A follow-up while a site
 * is open must continue in that tab; a web search engine is only the last resort.
 */
describe('user-reported follow-ups (real Chrome)', () => {
  const RESULTS = tab('https://www.flipkart.com/search?q=iphone');

  it('B1: "click the second product" in any natural wording picks from the open results', () => {
    const CASES: Array<[string, number]> = [
      ['click the second product', 2],
      ['now click the second product', 2],
      ['click the 2nd phone', 2],
      ['click the second iphone', 2],
      ['ok now open the third one', 3],
      ['then click on the 2nd product please', 2],
      ['select the first item', 1],
    ];
    for (const [text, ordinal] of CASES) {
      const { profile, decision } = decide(text, RESULTS);
      expect(profile, text).toMatchObject({ action: 'open_result', ordinal });
      expect(decision, text).toMatchObject({ ok: true, reuse: true, targetSource: 'CURRENT_PAGE' });
    }
  });

  it('B1: a bare query while a searchable site is open searches that site, not Google', () => {
    for (const text of ['iphone 15', 'now samsung phones', 'now search samsung phones']) {
      const { profile, decision } = decide(text, RESULTS, SEARCHABLE);
      expect(needsContextFit(profile, RESULTS), text).toBe(true);
      expect(decision, text).toMatchObject({
        ok: true,
        reuse: true,
        targetSource: 'CURRENT_PAGE',
        target: { domain: 'www.flipkart.com' },
      });
      expect(profile.query, text).not.toMatch(/^now\b/);
    }
    // Nothing open (or the page cannot search): a search engine is still the honest last resort.
    expect(decide('iphone 15', null).decision).toMatchObject({
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
    });
  });

  it('B2: browser commands the agent cannot do yet are refused honestly, never web-searched', () => {
    // Scroll, back and add-to-cart became real commands in Phase 5 (tested below); these remain
    // unsupported and are still refused honestly.
    for (const text of ['refresh the page', 'show cheaper ones', 'sort by price', 'zoom in']) {
      const { profile, decision } = decide(text, RESULTS, SEARCHABLE);
      expect(profile.intent, text).toBe('unknown');
      expect(profile.query, text).toBeNull();
      expect(decision, text).toMatchObject({ ok: false, code: 'UNSUPPORTED_COMMAND' });
      expect(decision.ok ? '' : decision.message, text).toMatch(/can't .* yet/i);
    }
  });

  it('Phase 5: page commands are actions on the open page, never web searches', () => {
    const cases: Array<[string, string, string]> = [
      ['scroll down', 'scroll', 'down'],
      ['now scroll up a bit', 'scroll', 'up'],
      ['go back', 'go_back', 'back'],
      ['go forward', 'go_forward', 'forward'],
      ['add it to cart', 'add_to_cart', 'cart'],
      ['open my cart', 'checkout', 'cart'],
      ['proceed to checkout', 'checkout', 'checkout'],
      ['fill this form using my saved profile', 'fill_form', 'profile'],
      ['fill my delivery address', 'fill_form', 'profile'],
      ['summarize this page', 'summarize', 'page'],
      ['what is this page about?', 'summarize', 'page'],
      ['open the cheapest one', 'pick_item', 'cheapest'],
      ['the cheapest one please', 'pick_item', 'cheapest'],
      ['show me the most expensive', 'pick_item', 'costliest'],
      ['click the top rated one', 'pick_item', 'top-rated'],
    ];
    for (const [text, action, param] of cases) {
      const { profile } = decide(text, RESULTS, SEARCHABLE);
      expect(profile.action, text).toBe(action);
      expect(profile.query, text).toBeNull();
      expect(profile.entities, text).toContainEqual({ type: 'command', value: param });
      expect(profile.confidence, text).toBeGreaterThanOrEqual(0.8);
    }
    // A superlative inside a search stays a search.
    expect(resolveIntent('find the cheapest laptop on amazon').profile.action).toBe('search');
  });

  it('B3: "Open Flipkart iPhone" opens Flipkart and searches the rest', () => {
    expect(resolveIntent('Open Flipkart iPhone').profile).toMatchObject({
      targetDomain: 'flipkart.com',
      action: 'search',
      intent: 'shopping',
      query: 'iPhone',
    });
    expect(resolveIntent('open youtube kannada songs').profile).toMatchObject({
      targetDomain: 'youtube.com',
      action: 'search',
      query: 'kannada songs',
    });
    // Plain navigation stays navigation.
    for (const text of ['Open YouTube', 'open the youtube website', 'go to flipkart.com']) {
      expect(resolveIntent(text).profile, text).toMatchObject({ action: 'navigate', query: null });
    }
  });

  it('B4: a leading article is not part of the query', () => {
    expect(resolveIntent('Open YouTube and play a Kannada song').profile).toMatchObject({
      action: 'search_and_play',
      query: 'Kannada song',
    });
    expect(resolveIntent('find an electric kettle on flipkart').profile.query).toBe(
      'electric kettle',
    );
  });
});
