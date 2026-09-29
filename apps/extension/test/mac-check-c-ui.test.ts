import type { TaskResult } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import { skillMenuItems } from '../src/sidepanel/skill-menu.js';
import { spokenSummary } from '../src/sidepanel/voice.js';

/** Batch C manual check on the Mac (2026-09-29): side panel requests. */
describe('side panel — "/" skill menu', () => {
  it('"/" lists all 12 built-in skills plus the user\'s own', () => {
    const lamp = {
      id: 'custom-lamp',
      name: 'Lamp deals',
      icon: '💡',
      description: '',
      triggers: ['lamp deals for {input}'],
      steps: ['search lamps'],
      createdAt: 0,
    };
    const all = skillMenuItems('', [lamp]);
    expect(all).toHaveLength(13);
    expect(all.at(-1)!.insert).toBe('lamp deals for ');
  });

  it('"/summ" suggests summarize and fills the sentence', () => {
    const items = skillMenuItems('summ', []);
    expect(items[0]!.id).toBe('summarize-page');
    expect(items[0]!.insert).toBe('summarize this page');
  });
});

describe('spoken replies say what was done in plain words', () => {
  const base = { status: 'COMPLETED', output: null, handover: null, error: null };
  it('a search says where and what', () => {
    const r = {
      ...base,
      intent: { language: 'en', action: 'search', query: 'laptop', targetDomain: 'flipkart.com' },
      target: { domain: 'www.flipkart.com' },
    } as unknown as TaskResult;
    expect(spokenSummary(r).text).toBe('Done. I searched Flipkart for "laptop".');
  });

  it('playback says what is playing', () => {
    const r = {
      ...base,
      intent: { language: 'en', action: 'search_and_play', query: 'Kannada songs' },
      target: { domain: 'www.youtube.com' },
    } as unknown as TaskResult;
    expect(spokenSummary(r).text).toBe('Done. Playing "Kannada songs" on Youtube.');
  });
});
