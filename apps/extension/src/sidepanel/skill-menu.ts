import { SKILL_IDS, SKILLS } from '@techie-mind/agent-core';
import type { CustomSkill, SkillId } from '@techie-mind/contracts';

/** What choosing a built-in skill in the "/" menu puts in the box (finish typing, then send). */
const EXAMPLES: Record<SkillId, string> = {
  'summarize-page': 'summarize this page',
  'deep-research': 'research ',
  'extract-data': 'extract the data as csv',
  'compare-prices': 'compare  prices on Amazon and Flipkart',
  'fill-form': 'fill this form using my saved profile',
  'find-alternatives': 'find alternatives to ',
  'manage-bookmarks': 'bookmark this page',
  'monitor-page': 'monitor this product until the price drops below ₹',
  'organize-tabs': 'organize my tabs',
  'read-later': 'save this for later',
  'save-page': 'save this page',
  'screenshot-walkthrough': 'take a screenshot walkthrough',
};

export interface SkillMenuItem {
  id: string;
  name: string;
  description: string;
  insert: string;
}

/** Built-in skills and the user's own skills, filtered by what follows the "/". */
export function skillMenuItems(filter: string, custom: readonly CustomSkill[]): SkillMenuItem[] {
  const items: SkillMenuItem[] = [
    ...SKILL_IDS.map((id) => ({
      id,
      name: SKILLS[id].name,
      description: SKILLS[id].description,
      insert: EXAMPLES[id],
    })),
    ...custom.map((s) => ({
      id: s.id,
      name: `${s.icon} ${s.name}`.trim(),
      description: s.description || s.steps.join(' → '),
      insert: `${s.triggers[0]!.replace(/\{input\}/g, '').trimEnd()} `,
    })),
  ];
  const f = filter.trim().toLowerCase();
  return f ? items.filter((i) => `${i.id} ${i.name} ${i.insert}`.toLowerCase().includes(f)) : items;
}
