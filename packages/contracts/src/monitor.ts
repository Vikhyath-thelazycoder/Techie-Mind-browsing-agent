import { z } from 'zod';
import { Id, ShortText, Timestamp, WebUrl } from './primitives.js';

export const MonitorCondition = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('price-below'),
    threshold: z.number().positive(),
    currency: z.enum(['INR', 'USD', 'EUR']),
  }),
  z.strictObject({ kind: z.literal('content-changed') }),
  z.strictObject({ kind: z.literal('available') }),
]);
export type MonitorCondition = z.infer<typeof MonitorCondition>;

/** A server-owned background monitor (spec §38–43). Recipients are referenced by id, never by address. */
export const Monitor = z.strictObject({
  monitorId: Id,
  ownerId: Id,
  url: WebUrl.refine((u) => u.startsWith('https://'), 'monitors only fetch https URLs'),
  condition: MonitorCondition,
  intervalMinutes: z.number().int().min(5).max(10_080),
  status: z.enum(['active', 'paused', 'cancelled', 'error']),
  recipientId: Id,
  createdAt: Timestamp,
  lastCheckedAt: Timestamp.nullable(),
});
export type Monitor = z.infer<typeof Monitor>;

export const MonitorResult = z.strictObject({
  monitorId: Id,
  checkedAt: Timestamp,
  conditionMet: z.boolean(),
  previousConditionMet: z.boolean().nullable(),
  /** True only on a false → true transition; drives notification with dedupe. */
  transition: z.boolean(),
  observedValue: z.union([z.number(), z.string().max(256)]).nullable(),
  error: ShortText.nullable(),
});
export type MonitorResult = z.infer<typeof MonitorResult>;

export const Notification = z.strictObject({
  notificationId: Id,
  monitorId: Id,
  channel: z.literal('email'),
  status: z.enum(['pending', 'sent', 'failed', 'suppressed']),
  dedupeKey: z.string().min(1).max(256),
  createdAt: Timestamp,
  sentAt: Timestamp.nullable(),
});
export type Notification = z.infer<typeof Notification>;
