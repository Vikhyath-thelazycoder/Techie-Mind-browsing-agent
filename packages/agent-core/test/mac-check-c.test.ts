import { parseInterpretation, parseTranslation } from '@techie-mind/models';
import { describe, expect, it } from 'vitest';
import { detectSkill, isSmallTalk, needsModel, resolveIntent } from '../src/index.js';

/** Sentences from the Batch C manual check on the Mac (2026-09-29), exactly as the user said them. */
describe('Batch C Mac check — language, stock alerts, small talk', () => {
  it('"tell me when this is back in stock" is a stock monitor, not a store search', () => {
    expect(detectSkill('tell me when this is back in stock')).toEqual({
      id: 'monitor-page',
      arg: 'back in stock',
    });
    expect(detectSkill('notify me when it is available again')?.id).toBe('monitor-page');
    expect(resolveIntent('tell me when this is back in stock').profile.action).toBe('skill');
  });

  it('romanized Kannada: "open maadi … play maadu" plays the songs, the verbs are not the query', () => {
    const p = resolveIntent('YouTube open maadi Kannada songs play maadu').profile;
    expect(p.action).toBe('search_and_play');
    expect(p.targetDomain).toBe('youtube.com');
    expect(p.query).toBe('Kannada songs');
  });

  it('voice mishearing "pay 5000 say come" is read as "pe 5000 se kam"', () => {
    for (const text of [
      'flipkart pe 50000 se kam laptop dhoondo',
      'Flipkart pay 5000 say come laptop Dhoondo',
    ]) {
      const p = resolveIntent(text).profile;
      expect(p.targetDomain, text).toBe('flipkart.com');
      expect(p.query, text).toBe('laptop');
    }
  });

  it('"neeche scroll down karo" scrolls', () => {
    expect(resolveIntent('neeche scroll down karo').profile.action).toBe('scroll');
    expect(resolveIntent('neeche scroll karo').profile.action).toBe('scroll');
  });

  it('Indian-language words left in a query go to the local model to be read', () => {
    const p = resolveIntent('Kannada songs play maadi').profile;
    expect(needsModel({ ...p, query: 'maadi Kannada songs' })).toBe(true);
    expect(needsModel({ ...p, language: 'en', query: 'maadi Kannada songs' })).toBe(false);
  });

  it('a translation must be one English JSON answer', () => {
    expect(parseTranslation('{"english":"open YouTube and play Kannada songs"}')).toBe(
      'open YouTube and play Kannada songs',
    );
    // Still in Kannada script → not a translation; extra keys or free text → refused.
    expect(parseTranslation('{"english":"ಕನ್ನಡ songs"}')).toBeNull();
    expect(parseTranslation('{"english":"play","note":"x"}')).toBeNull();
    expect(parseTranslation('play songs')).toBeNull();
    // What the translation turns into is read by the same rules as a typed English request.
    const p = resolveIntent('open YouTube and play Kannada songs').profile;
    expect([p.action, p.targetDomain, p.query]).toEqual([
      'search_and_play',
      'youtube.com',
      'Kannada songs',
    ]);
  });

  it('small talk is recognised and the model may answer with a chat reply', () => {
    for (const t of ['how are you', 'Hi bro', 'who are you?', 'thank you', 'kaise ho']) {
      expect(isSmallTalk(t), t).toBe(true);
    }
    expect(isSmallTalk('how to cook rice')).toBe(false);
    expect(isSmallTalk('play some music')).toBe(false);
    expect(
      parseInterpretation(
        '{"kind":"chat","reply":"I am doing well! How can I help?","confidence":0.9,"reason":"greeting"}',
      ),
    ).toEqual({
      kind: 'chat',
      reply: 'I am doing well! How can I help?',
      confidence: 0.9,
      reason: 'greeting',
    });
  });
});
