import { CustomSkill, SkillId } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import {
  customSkillId,
  matchCustomSkill,
  SKILL_EXAMPLES,
  validateCustomSkill,
} from '../src/custom-skills.js';
import { resolveIntent } from '../src/intent.js';

const LAPTOPS = CustomSkill.parse({
  id: 'custom-laptop-deals',
  name: 'Laptop deals',
  icon: '💻',
  description: 'Cheapest laptop under a budget on Flipkart',
  triggers: ['laptop deals under {input}', 'find me a cheap laptop'],
  steps: ['search laptops under {input} on Flipkart', 'open the cheapest one'],
  createdAt: 0,
});

/** The skill a sentence reaches: a skill entity, or the page command the skill is built on. */
function reachedSkill(text: string): string | null {
  const p = resolveIntent(text).profile;
  const skill = p.entities.find((e) => e.type === 'skill')?.value;
  if (skill) return skill;
  if (p.action === 'summarize') return 'summarize-page';
  if (p.action === 'fill_form') return 'fill-form';
  return null;
}

describe('built-in skill examples shown in Settings', () => {
  it('every example sentence really starts its skill (the UI cannot promise what does not work)', () => {
    for (const id of SkillId.options) {
      expect(SKILL_EXAMPLES[id].length, id).toBeGreaterThan(0);
      for (const example of SKILL_EXAMPLES[id]) {
        expect(reachedSkill(example), example).toBe(id);
      }
      expect(reachedSkill(`/${id}`), `/${id}`).toBe(id);
    }
  });
});

describe('custom skills — matching', () => {
  it('matches a trigger, captures {input} with the user casing, fills the steps', () => {
    const m = matchCustomSkill('Laptop deals under ₹40,000', [LAPTOPS]);
    expect(m?.skill.id).toBe('custom-laptop-deals');
    expect(m?.input).toBe('₹40,000');
    expect(m?.steps).toEqual(['search laptops under ₹40,000 on Flipkart', 'open the cheapest one']);
    expect(matchCustomSkill('find me a cheap laptop.', [LAPTOPS])?.steps[1]).toBe(
      'open the cheapest one',
    );
  });

  it('does not match other sentences or an empty {input}', () => {
    expect(matchCustomSkill('laptop deals under', [LAPTOPS])).toBeNull();
    expect(matchCustomSkill('show laptop deals', [LAPTOPS])).toBeNull();
    expect(matchCustomSkill('open YouTube', [LAPTOPS])).toBeNull();
  });
});

describe('custom skills — validation before saving', () => {
  const draft = (patch: Partial<CustomSkill>) => ({
    ...LAPTOPS,
    id: 'custom-new',
    name: 'New',
    ...patch,
  });

  it('accepts steps written as ordinary commands', () => {
    expect(validateCustomSkill(LAPTOPS, [])).toEqual([]);
  });

  it('refuses steps the agent does not understand, purchases and page commands it cannot do', () => {
    const issues = validateCustomSkill(
      draft({
        triggers: ['weekend shopping'],
        steps: ['open Flipkart', 'buy it now', 'scroll down', 'hmm'],
      }),
      [],
    ).map((i) => i.message);
    expect(issues.some((m) => /Step 2 buys something/.test(m))).toBe(true);
    expect(issues.some((m) => /Step 1/.test(m))).toBe(false);
  });

  it('refuses triggers that clash with a built-in skill or another custom skill', () => {
    const builtIn = validateCustomSkill(draft({ triggers: ['summarize this page'] }), []);
    expect(builtIn.map((i) => i.message).join(' ')).toMatch(/built-in/);
    const clash = validateCustomSkill(draft({ triggers: ['find me a cheap laptop'] }), [LAPTOPS]);
    expect(clash.map((i) => i.message).join(' ')).toMatch(/Laptop deals/);
  });

  it('refuses a skill that calls a skill, and {input} with nothing to fill it', () => {
    const recursive = validateCustomSkill(
      draft({ triggers: ['my morning'], steps: ['find me a cheap laptop'] }),
      [LAPTOPS],
    );
    expect(recursive.map((i) => i.message).join(' ')).toMatch(/can't call skills/);
    const noInput = validateCustomSkill(
      draft({ triggers: ['my deals'], steps: ['search {input} on Flipkart'] }),
      [],
    );
    expect(noInput.map((i) => i.message).join(' ')).toMatch(/no trigger sentence has \{input\}/);
  });

  it('ids come from the name and never collide', () => {
    expect(customSkillId('Laptop deals!', [])).toBe('custom-laptop-deals');
    expect(customSkillId('Laptop deals', ['custom-laptop-deals'])).toBe('custom-laptop-deals-2');
  });
});
