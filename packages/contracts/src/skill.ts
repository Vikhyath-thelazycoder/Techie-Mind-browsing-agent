import { z } from 'zod';
import { RiskLevel } from './primitives.js';

/** The 12 first-class skills (spec §30). */
export const SkillId = z.enum([
  'summarize-page',
  'deep-research',
  'extract-data',
  'compare-prices',
  'fill-form',
  'find-alternatives',
  'manage-bookmarks',
  'monitor-page',
  'organize-tabs',
  'read-later',
  'save-page',
  'screenshot-walkthrough',
]);
export type SkillId = z.infer<typeof SkillId>;

export const SkillInputField = z.strictObject({
  name: z.string().min(1).max(64),
  type: z.enum(['string', 'number', 'boolean', 'url', 'enum']),
  required: z.boolean(),
  description: z.string().max(256),
  options: z.array(z.string().max(64)).max(32).nullable(),
});

/** Skill manifest: what every skill must declare (spec §30). */
export const Skill = z.strictObject({
  id: SkillId,
  name: z.string().min(1).max(64),
  description: z.string().max(512),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  inputs: z.array(SkillInputField).max(32),
  riskLevel: RiskLevel,
  requiresConfirmation: z.boolean(),
  permissions: z
    .array(z.enum(['tabs', 'bookmarks', 'storage', 'downloads', 'scripting', 'network']))
    .max(8),
  verification: z.string().max(512),
  failureHandling: z.string().max(512),
});
export type Skill = z.infer<typeof Skill>;

/**
 * A skill the user made in Settings: a name, the sentences that start it, and steps written as
 * ordinary commands the agent already understands. No code: every step runs through the same
 * pipeline (observe → ground → firewall → execute → verify) as a typed request.
 * `{input}` in a trigger captures words, and the same `{input}` in a step inserts them.
 */
export const CustomSkill = z.strictObject({
  id: z.string().regex(/^custom-[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(40),
  icon: z.string().max(8),
  description: z.string().max(200),
  triggers: z.array(z.string().trim().min(3).max(80)).min(1).max(5),
  steps: z.array(z.string().trim().min(2).max(200)).min(1).max(10),
  createdAt: z.number().int().nonnegative(),
});
export type CustomSkill = z.infer<typeof CustomSkill>;

/**
 * The user's skill settings (stored locally under SKILLS_STORAGE_KEY): extra instructions for the
 * built-in skills whose output a model writes, and the user's own skills.
 */
export const SkillsConfig = z.strictObject({
  instructions: z.partialRecord(SkillId, z.string().max(500)),
  custom: z.array(CustomSkill).max(30),
});
export type SkillsConfig = z.infer<typeof SkillsConfig>;

export const SKILLS_STORAGE_KEY = 'techieMind.skills';
export const EMPTY_SKILLS_CONFIG: SkillsConfig = { instructions: {}, custom: [] };
