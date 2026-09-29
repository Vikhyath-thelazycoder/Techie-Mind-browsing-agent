import type { CustomSkill, SkillId } from '@techie-mind/contracts';
import { resolveIntent } from './intent.js';
import { detectSkill } from './skills.js';
import { normalize } from './text.js';

/**
 * Skills in Settings (user-facing): example sentences for the 12 built-in skills, and the user's
 * own skills — named shortcuts whose steps are ordinary commands. A custom skill never adds a
 * capability: each step is run exactly as if the user had typed it, through the same firewall.
 */

/** Sentences that start each built-in skill. Tested: every one really reaches its skill. */
export const SKILL_EXAMPLES: Record<SkillId, string[]> = {
  'summarize-page': ['summarize this page', "what's this page about"],
  'deep-research': ['research budget laptops', 'do deep research on electric scooters'],
  'extract-data': ['export the table as csv', 'extract the data as json'],
  'compare-prices': ['compare iPhone 15 prices on Amazon and Flipkart'],
  'fill-form': ['fill my delivery address', 'fill this form with my profile'],
  'find-alternatives': ['find alternatives to Sony WH-1000XM5'],
  'manage-bookmarks': [
    'bookmark this page',
    'show my bookmarks for cricket',
    'remove this bookmark',
  ],
  'monitor-page': ['monitor this product until the price drops below ₹50,000'],
  'organize-tabs': ['organize my tabs', 'close duplicate tabs'],
  'read-later': ['save this for later', 'show my reading list'],
  'save-page': ['save this page'],
  'screenshot-walkthrough': ['take a screenshot walkthrough'],
};

/** Built-in skills whose output a local model writes (so their prompt can take instructions). */
export const MODEL_SKILLS: ReadonlySet<SkillId> = new Set(['summarize-page', 'deep-research']);

const INPUT = '{input}';

const clean = (text: string) =>
  normalize(text)
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface CustomSkillMatch {
  skill: CustomSkill;
  /** Words captured by `{input}` (empty when the trigger has none). */
  input: string;
  /** The steps with `{input}` filled in, ready to run in order. */
  steps: string[];
}

/** Does the request start one of the user's skills? Whole-sentence match, case-insensitive. */
export function matchCustomSkill(
  text: string,
  skills: readonly CustomSkill[],
): CustomSkillMatch | null {
  const said = clean(text);
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const t = clean(trigger);
      let input: string | null = null;
      if (t.includes(INPUT)) {
        const [before = '', after = ''] = t.split(INPUT);
        if (said.startsWith(before) && said.endsWith(after)) {
          const middle = said.slice(before.length, said.length - after.length).trim();
          if (middle && said.length >= before.length + after.length) input = middle;
        }
      } else if (said === t) {
        input = '';
      }
      if (input !== null) {
        const original = text.trim().replace(/[.!?]+$/u, '');
        // Keep the user's own casing for the captured words.
        const cased = input ? (new RegExp(escape(input), 'iu').exec(original)?.[0] ?? input) : '';
        return {
          skill,
          input: cased,
          steps: skill.steps.map((s) => s.split(INPUT).join(cased).trim()),
        };
      }
    }
  }
  return null;
}

/**
 * The built-in skill a sentence already starts: a skill phrase or `/id`, or one of the page
 * commands two skills are built on ("summarize this page", "fill my delivery address").
 */
export function builtInSkillOf(text: string): SkillId | null {
  const direct = detectSkill(text);
  if (direct) return direct.id;
  const { profile } = resolveIntent(text);
  if (profile.action === 'summarize') return 'summarize-page';
  if (profile.action === 'fill_form') return 'fill-form';
  return null;
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ValidationIssue {
  field: 'name' | 'triggers' | 'steps';
  message: string;
}

/**
 * Check a skill before it is saved: every step must be a command the agent understands, no step
 * buys anything or starts another custom skill, and triggers must not clash with built-in skills
 * or the user's other skills.
 */
export function validateCustomSkill(
  skill: Pick<CustomSkill, 'id' | 'name' | 'triggers' | 'steps'>,
  others: readonly CustomSkill[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const rest = others.filter((o) => o.id !== skill.id);
  if (!skill.name.trim()) issues.push({ field: 'name', message: 'Give the skill a name.' });
  if (rest.some((o) => o.name.trim().toLowerCase() === skill.name.trim().toLowerCase())) {
    issues.push({ field: 'name', message: `You already have a skill called "${skill.name}".` });
  }

  const triggers = skill.triggers.map((t) => t.trim()).filter(Boolean);
  if (triggers.length === 0) {
    issues.push({ field: 'triggers', message: 'Add at least one sentence that starts the skill.' });
  }
  const usesInput = triggers.some((t) => t.includes(INPUT));
  for (const trigger of triggers) {
    const sample = trigger.split(INPUT).join('sample');
    if (clean(trigger.split(INPUT).join('')).length < 3) {
      issues.push({ field: 'triggers', message: `"${trigger}" is too short to recognise.` });
      continue;
    }
    if (trigger.split(INPUT).length > 2) {
      issues.push({ field: 'triggers', message: `"${trigger}": use {input} at most once.` });
    }
    const builtIn = builtInSkillOf(sample);
    if (builtIn) {
      issues.push({
        field: 'triggers',
        message: `"${trigger}" already starts the built-in "${builtIn}" skill.`,
      });
    }
    const clash = matchCustomSkill(sample, rest);
    if (clash) {
      issues.push({
        field: 'triggers',
        message: `"${trigger}" already starts your skill "${clash.skill.name}".`,
      });
    }
  }

  const steps = skill.steps.map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0) issues.push({ field: 'steps', message: 'Add at least one step.' });
  steps.forEach((step, i) => {
    const n = i + 1;
    if (step.includes(INPUT) && !usesInput) {
      issues.push({
        field: 'steps',
        message: `Step ${n} uses {input}, but no trigger sentence has {input} to fill it.`,
      });
    }
    const sample = step.split(INPUT).join('sample');
    if (matchCustomSkill(sample, [...rest, skill as CustomSkill])) {
      issues.push({
        field: 'steps',
        message: `Step ${n} starts a custom skill — skills can't call skills.`,
      });
      return;
    }
    const { profile } = resolveIntent(sample);
    const unsupported = profile.entities.find((e) => e.type === 'unsupported');
    if (profile.action === 'purchase') {
      issues.push({
        field: 'steps',
        message: `Step ${n} buys something — payments are always done by you, never by a skill.`,
      });
    } else if (unsupported) {
      issues.push({
        field: 'steps',
        message: `Step ${n}: Techie Mind can't "${unsupported.value}" yet.`,
      });
    } else if (profile.intent === 'unknown' || !profile.action) {
      issues.push({
        field: 'steps',
        message: `Step ${n} ("${step}") is not a command Techie Mind understands — write it the way you would type it in the panel.`,
      });
    }
  });
  return issues;
}

/** A stable id from the name ("Laptop deals" → "custom-laptop-deals"). */
export function customSkillId(name: string, taken: readonly string[]): string {
  const base =
    normalize(name)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'skill';
  let id = `custom-${base}`;
  for (let i = 2; taken.includes(id); i++) id = `custom-${base}-${i}`;
  return id;
}
