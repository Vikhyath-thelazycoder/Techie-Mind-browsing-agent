import { describe, expect, it } from 'vitest';
import { detectLanguage, resolveIntent } from '../src/intent.js';

type Expect = {
  intent: string;
  domain: string | null;
  query: string | null;
  action?: string | null;
};

const CASES: Array<[string, Expect]> = [
  // Acceptance phrasings.
  [
    'Open YouTube and search for Kannada songs.',
    { intent: 'search', domain: 'youtube.com', query: 'Kannada songs' },
  ],
  [
    'Open YouTube and search for Python tutorials.',
    { intent: 'search', domain: 'youtube.com', query: 'Python tutorials' },
  ],
  [
    'Open Flipkart and search for running shoes.',
    { intent: 'shopping', domain: 'flipkart.com', query: 'running shoes' },
  ],
  // Different wording, same structure.
  [
    'go to youtube and look up lo-fi beats',
    { intent: 'search', domain: 'youtube.com', query: 'lo-fi beats' },
  ],
  [
    'search youtube for how to play guitar',
    { intent: 'search', domain: 'youtube.com', query: 'how to play guitar' },
  ],
  [
    'search for how to play guitar on youtube',
    { intent: 'search', domain: 'youtube.com', query: 'how to play guitar' },
  ],
  [
    'on youtube, search carnatic violin',
    { intent: 'search', domain: 'youtube.com', query: 'carnatic violin' },
  ],
  [
    'Search Flipkart for bluetooth headphones',
    { intent: 'shopping', domain: 'flipkart.com', query: 'bluetooth headphones' },
  ],
  [
    'find running shoes under ₹5000 on flipkart',
    { intent: 'shopping', domain: 'flipkart.com', query: 'running shoes' },
  ],
  [
    'Can you please open amazon and find a steel water bottle',
    { intent: 'shopping', domain: 'amazon.in', query: 'steel water bottle' },
  ],
  [
    'visit wikipedia and search for Indian Space Research Organisation',
    { intent: 'search', domain: 'wikipedia.org', query: 'Indian Space Research Organisation' },
  ],
  [
    'search github for "playwright"',
    { intent: 'search', domain: 'github.com', query: 'playwright' },
  ],
  [
    'search youtube for node.js tutorial',
    { intent: 'search', domain: 'youtube.com', query: 'node.js tutorial' },
  ],
  // Explicit and unknown domains.
  [
    'go to youtube.com and search for chess openings',
    { intent: 'search', domain: 'youtube.com', query: 'chess openings' },
  ],
  [
    'open shop.fixture.test and search for trail running shoes',
    { intent: 'search', domain: 'shop.fixture.test', query: 'trail running shoes' },
  ],
  // Playback.
  [
    'Open YouTube and play some Kannada songs',
    {
      intent: 'media_playback',
      domain: 'youtube.com',
      query: 'Kannada songs',
      action: 'search_and_play',
    },
  ],
  // No site named: the resolver does not pick a destination; the navigation policy does (current
  // media page, else the default media site — see navigation.test.ts).
  [
    'play relaxing piano music',
    { intent: 'media_playback', domain: null, query: 'relaxing piano music' },
  ],
  // Multilingual / code-switched.
  ['Kannada songs play maadi', { intent: 'media_playback', domain: null, query: 'Kannada songs' }],
  [
    'Flipkart alli running shoes search maadu',
    { intent: 'shopping', domain: 'flipkart.com', query: 'running shoes' },
  ],
  [
    'Amazon pe black shoes dhoondo',
    { intent: 'shopping', domain: 'amazon.in', query: 'black shoes' },
  ],
  [
    'youtube par hindi gaane chalao',
    { intent: 'media_playback', domain: 'youtube.com', query: 'hindi gaane' },
  ],
  // Navigation only.
  ['Open YouTube', { intent: 'navigate', domain: 'youtube.com', query: null }],
  ['take me to github', { intent: 'navigate', domain: 'github.com', query: null }],
  ['Go to Flipkart.', { intent: 'navigate', domain: 'flipkart.com', query: null }],
  // No site → generic search (Google is the fallback, not the default for named sites).
  [
    'find laptops with 16GB RAM under ₹70,000',
    { intent: 'search', domain: null, query: 'laptops with 16GB RAM' },
  ],
];

describe('resolveIntent — generic clause-based resolution', () => {
  it.each(CASES)('%s', (text, want) => {
    const { profile } = resolveIntent(text);
    expect(profile.intent).toBe(want.intent);
    expect(profile.targetDomain).toBe(want.domain);
    expect(profile.query).toBe(want.query);
    if (want.action !== undefined) expect(profile.action).toBe(want.action);
    expect(profile.resolvedBy).toBe('deterministic');
  });

  it('never folds the site name into a generic search query (spec §46)', () => {
    const { profile } = resolveIntent('Open YouTube and play some Kannada songs');
    expect(profile.query).not.toMatch(/youtube/);
    expect(profile.directNavigation).toBe(true);
  });

  it('extracts price constraints with currency and multipliers', () => {
    expect(resolveIntent('find running shoes under ₹5000 on flipkart').profile.constraints).toEqual(
      [{ field: 'price', op: '<=', value: 5000, unit: 'INR' }],
    );
    expect(resolveIntent('search amazon for laptops under 50k').profile.constraints).toEqual([
      { field: 'price', op: '<=', value: 50000, unit: null },
    ]);
    expect(resolveIntent('find phones above rs 20,000').profile.constraints[0]).toMatchObject({
      op: '>=',
      value: 20000,
    });
  });

  it('marks purchases as high-risk and requiring confirmation', () => {
    const { profile } = resolveIntent('buy this laptop on flipkart');
    expect(profile.action).toBe('purchase');
    expect(profile.riskLevel).toBe('HIGH');
    expect(profile.requiresConfirmation).toBe(true);
  });

  it('returns unknown for empty intent rather than guessing', () => {
    expect(resolveIntent('please').profile.intent).toBe('unknown');
  });

  it('language detection does not change the structured intent (spec §45)', () => {
    const en = resolveIntent('search flipkart for running shoes').profile;
    const kn = resolveIntent('Flipkart alli running shoes search maadu').profile;
    expect(kn.language).toBe('mixed');
    expect(en.language).toBe('en');
    expect({ ...kn, language: 'en', confidence: 0 }).toMatchObject({
      intent: en.intent,
      targetDomain: en.targetDomain,
      query: en.query,
      riskLevel: en.riskLevel,
    });
  });
});

describe('detectLanguage', () => {
  it('detects scripts and romanised code-switching', () => {
    expect(detectLanguage('ಕನ್ನಡ ಹಾಡುಗಳು')).toBe('kn');
    expect(detectLanguage('हिंदी गाने')).toBe('hi');
    expect(detectLanguage('Amazon pe black shoes dhoondo')).toBe('hinglish');
    expect(detectLanguage('Kannada songs play maadi')).toBe('mixed');
    expect(detectLanguage('Open YouTube')).toBe('en');
  });
});
