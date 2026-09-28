import { describe, expect, it } from 'vitest';
import { previewPlan } from '../src/sidepanel/task-client.js';

const FLIPKART = {
  tabId: 3,
  url: 'https://www.flipkart.com/search?q=phones',
  origin: 'https://www.flipkart.com',
  host: 'www.flipkart.com',
  title: 'Phones',
  source: 'active-tab' as const,
};

/**
 * "Ask before acting" preview. Bug seen on the Mac (2026-09-29): "now open the samsung one" showed
 * "Could not understand what to open or do" with Run disabled, so the local AI was never asked.
 */
describe('plan preview', () => {
  it('lets an unsure request run so the local AI can decide (no blocking "could not understand")', () => {
    for (const text of [
      'now open the samsung one',
      '“now open the samsung one”',
      'open the good one',
    ]) {
      const p = previewPlan(text, FLIPKART);
      expect(p.problem, text).toBeNull();
      expect(p.needsModel, text).toBe(true);
      expect(p.steps[0], text).toMatch(/local AI/);
      expect(p.steps[1], text).toMatch(/www\.flipkart\.com/);
    }
  });

  it('keeps the code-only plan for confident requests', () => {
    const p = previewPlan('iphone 15', FLIPKART);
    expect(p.needsModel).toBeFalsy();
    expect(p.problem).toBeNull();
    expect(p.steps.join(' | ')).toMatch(/iphone 15/);
  });

  it('still explains requests nothing can do', () => {
    expect(previewPlan('scroll down', FLIPKART).problem).toMatch(/can't .* yet/);
  });
});
