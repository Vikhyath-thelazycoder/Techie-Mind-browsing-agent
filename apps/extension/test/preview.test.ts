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

  it('shows the steps of one of your own skills (Settings → Skills)', () => {
    const lamp = {
      id: 'custom-lamp-deals',
      name: 'Lamp deals',
      icon: '💡',
      description: '',
      triggers: ['lamp deals for {input}'],
      steps: ['open form.fixture.test and search for {input}', 'open the first result'],
      createdAt: 0,
    };
    const p = previewPlan('lamp deals for desk lamp', FLIPKART, [lamp]);
    expect(p.problem).toBeNull();
    expect(p.skill).toBe('Lamp deals');
    expect(p.steps).toEqual([
      'Step 1: open form.fixture.test and search for desk lamp',
      'Step 2: open the first result',
      'Stop at the first step that does not complete',
    ]);
  });

  it('still explains requests nothing can do', () => {
    expect(previewPlan('refresh the page', FLIPKART).problem).toMatch(/can't .* yet/);
  });

  it('previews Phase 5 page commands as real steps on the open page', () => {
    const p = previewPlan('scroll down', FLIPKART);
    expect(p.problem).toBeNull();
    expect(p.steps.join(' | ')).toMatch(/Scroll down/);
    expect(previewPlan('open the cheapest one', FLIPKART).steps.join(' | ')).toMatch(/cheapest/);
  });
});
