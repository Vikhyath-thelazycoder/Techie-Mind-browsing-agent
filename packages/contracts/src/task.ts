import { z } from 'zod';
import { Id, Language, Timestamp } from './primitives.js';

/** Task lifecycle, including the human-handover states of spec §25. */
export const TaskStatus = z.enum([
  'PENDING',
  'RUNNING',
  'HUMAN_REQUIRED',
  'PAUSED',
  'USER_COMPLETED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Composer mode selector in the side panel (reference UI: Search / Deep Search / Scrape). */
export const TaskMode = z.enum(['search', 'deep-search', 'scrape']);
export type TaskMode = z.infer<typeof TaskMode>;

/** Autonomy selector in the side panel (reference UI: Ask before acting / Act without asking). */
export const Autonomy = z.enum(['ask-before-acting', 'act-without-asking']);
export type Autonomy = z.infer<typeof Autonomy>;

export const Task = z.strictObject({
  taskId: Id,
  text: z.string().trim().min(1).max(4000),
  source: z.enum(['typed', 'voice', 'skill', 'rerun']),
  mode: TaskMode,
  autonomy: Autonomy,
  language: Language,
  status: TaskStatus,
  createdAt: Timestamp,
  maxSteps: z.number().int().min(1).max(100),
  skillId: Id.nullable(),
});
export type Task = z.infer<typeof Task>;
