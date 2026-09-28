import type { ProbeResponse } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { resolveIntent } from '../src/intent.js';
import { planGoals } from '../src/plan.js';
import { decideNavigation } from '../src/router.js';
import { countTerms } from '../src/text.js';
import {
  fieldHoldsQuery,
  isChallengePage,
  isSustainedPlayback,
  verifyNavigation,
  verifyOpenResult,
  verifySearch,
} from '../src/verify.js';
import { link, observation, searchField } from './nodes.js';

function probe(extra: Partial<ProbeResponse> = {}): ProbeResponse {
  return {
    type: 'PROBE_RESULT',
    url: 'https://www.youtube.com/',
    origin: 'https://www.youtube.com',
    title: 'YouTube',
    documentId: 'doc-1',
    version: 1,
    readyState: 'complete',
    element: null,
    media: { present: false, playing: false, currentTime: null },
    ...extra,
  };
}

describe('verifyNavigation', () => {
  it('accepts the target domain and its subdomains only', () => {
    expect(verifyNavigation('youtube.com', probe()).verified).toBe(true);
    expect(verifyNavigation('youtube.com', probe({ url: 'https://m.youtube.com/' })).verified).toBe(
      true,
    );
    expect(
      verifyNavigation('youtube.com', probe({ url: 'https://youtube.com.evil.test/' })).verified,
    ).toBe(false);
    expect(
      verifyNavigation('youtube.com', probe({ url: 'https://www.google.com/search?q=youtube' }))
        .verified,
    ).toBe(false);
    expect(verifyNavigation('youtube.com', null).verified).toBe(false);
  });
});

describe('verifySearch', () => {
  const before = observation([searchField()]);

  it('verifies a results page carrying the query with relevant results', () => {
    const after = observation([
      searchField({ value: 'Kannada songs' }),
      link('Kannada Hit Songs 2024', '/watch?v=1'),
    ]);
    const v = verifySearch({
      query: 'Kannada songs',
      before: probe(),
      beforeObs: before,
      after: probe({
        url: 'https://www.youtube.com/results?search_query=Kannada+songs',
        title: 'Kannada songs - YouTube',
      }),
      afterObs: after,
    });
    expect(v.verified).toBe(true);
    expect(v.relevantResults).toBe(1);
  });

  it('rejects when the page did not change', () => {
    const v = verifySearch({
      query: 'shoes',
      before: probe(),
      beforeObs: before,
      after: probe(),
      afterObs: before,
    });
    expect(v.verified).toBe(false);
  });

  it('rejects a results page for a DIFFERENT query', () => {
    const v = verifySearch({
      query: 'running shoes',
      before: probe(),
      beforeObs: before,
      after: probe({ url: 'https://shop.test/search?q=kitchen+knives', title: 'kitchen knives' }),
      afterObs: observation([link('Chef kitchen knives set', '/p/1')]),
    });
    expect(v.verified).toBe(false);
  });

  it('rejects a URL/title change with no visible results (results not rendered yet)', () => {
    const v = verifySearch({
      query: 'Kannada songs',
      before: probe(),
      beforeObs: before,
      after: probe({
        url: 'https://www.youtube.com/results?search_query=Kannada+songs',
        title: 'YouTube',
      }),
      afterObs: observation([searchField({ value: 'Kannada songs' })]),
    });
    expect(v.verified).toBe(false);
  });

  it('verifies an in-page search: same URL, field holds query, more relevant results', () => {
    const v = verifySearch({
      query: 'linen shirts',
      before: probe(),
      beforeObs: before,
      after: probe({ version: 5 }),
      afterObs: observation([
        searchField({ value: 'linen shirts' }),
        link('White linen shirts', '/p/1'),
      ]),
    });
    expect(v.verified).toBe(true);
  });
});

describe('media verification — preview players and trailers cannot fake success', () => {
  const before = probe({ url: 'https://www.youtube.com/results?search_query=x' });
  const playingAt = (t: number, url = 'https://www.youtube.com/watch?v=1') =>
    probe({ url, media: { present: true, playing: true, currentTime: t } });

  it('requires two samples with advancing position', () => {
    expect(isSustainedPlayback(playingAt(1), playingAt(2.2))).toBe(true);
    expect(isSustainedPlayback(playingAt(1), playingAt(1.1))).toBe(false); // stalled
    expect(
      isSustainedPlayback(playingAt(1), {
        ...playingAt(2),
        media: { present: true, playing: false, currentTime: 2 },
      }),
    ).toBe(false);
    expect(
      isSustainedPlayback(playingAt(1), playingAt(2, 'https://www.youtube.com/@channel')),
    ).toBe(false);
  });

  it('a single "playing" sample is not enough', () => {
    expect(verifyOpenResult({ before, after: playingAt(1), media: true }).verified).toBe(false);
    expect(
      verifyOpenResult({ before, after: playingAt(1), media: true, later: playingAt(2.3) })
        .verified,
    ).toBe(true);
  });

  it('a page without a main player (e.g. a channel page) is not playback', () => {
    const channel = probe({ url: 'https://www.youtube.com/@someone' });
    expect(verifyOpenResult({ before, after: channel, media: true, later: channel })).toMatchObject(
      {
        verified: false,
        evidence: expect.stringMatching(/no main media player/),
      },
    );
  });
});

describe('small helpers', () => {
  it('fieldHoldsQuery ignores case and spacing', () => {
    expect(fieldHoldsQuery(' Kannada  Songs ', 'kannada songs')).toBe(true);
    expect(fieldHoldsQuery('kannada', 'kannada songs')).toBe(false);
    expect(fieldHoldsQuery(null, 'x')).toBe(false);
  });

  it('term matching folds simple plurals ("songs" matches "Song")', () => {
    expect(countTerms('Maathu Nannovalu Song - Kannada', ['kannada', 'songs'])).toBe(2);
    expect(countTerms('Glass bottle', ['glas'])).toBe(0);
  });

  it('plans only supported goals and refuses unsupported ones', () => {
    const nav = resolveIntent('open github').profile;
    const route = decideNavigation(nav, null, null);
    expect(route.ok && route.target && planGoals(nav, route.target)).toMatchObject({
      ok: true,
      goals: [{ kind: 'navigate' }],
    });
    const buy = resolveIntent('buy an iphone on amazon').profile;
    const buyRoute = decideNavigation(buy, null, null);
    expect(buyRoute.ok && buyRoute.target && planGoals(buy, buyRoute.target)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_INTENT',
    });
  });

  it('routes named sites directly and uses Google only when no site is named and no page is open', () => {
    const named = decideNavigation(
      resolveIntent('Open Flipkart and search for running shoes').profile,
      null,
      null,
    );
    expect(named.ok && named.target).toMatchObject({
      domain: 'flipkart.com',
      url: 'https://www.flipkart.com/',
      reason: 'explicit-site',
    });
    const generic = decideNavigation(
      resolveIntent('find laptops with 16GB RAM').profile,
      null,
      null,
    );
    expect(generic.ok && generic.target).toMatchObject({
      domain: 'google.com',
      reason: 'generic-search',
    });
    const unknownDomain = decideNavigation(
      resolveIntent('go to example.org and search for docs').profile,
      null,
      null,
    );
    expect(unknownDomain.ok && unknownDomain.target).toMatchObject({
      url: 'https://example.org/',
      adapterId: null,
    });
  });
});

describe('isChallengePage — CAPTCHA / bot walls are never a verified result', () => {
  it('detects challenge interstitials by path, title and embedded challenge frames', () => {
    expect(
      isChallengePage(
        probe({
          url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dx',
        }),
        null,
      ),
    ).toBe(true);
    expect(isChallengePage(probe({ title: 'Access Denied' }), null)).toBe(true);
    expect(isChallengePage(probe({ title: 'Just a moment...' }), null)).toBe(true);
    const withFrame = observation([
      {
        ...link('Home', '/'),
        tag: 'iframe',
        role: null,
        attributes: { src: 'https://www.google.com/recaptcha/api2/anchor' },
      },
    ]);
    expect(isChallengePage(probe({ title: 'Please wait' }), withFrame)).toBe(true);
  });

  it("does not flag ordinary pages or the user's own query wording (negative control)", () => {
    expect(isChallengePage(probe({ title: 'Kannada songs - YouTube' }), null)).toBe(false);
    expect(
      isChallengePage(probe({ title: 'captcha solver - YouTube' }), null, 'captcha solver'),
    ).toBe(false);
  });
});
