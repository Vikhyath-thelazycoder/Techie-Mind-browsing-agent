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
