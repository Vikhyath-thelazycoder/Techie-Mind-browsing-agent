import { z } from 'zod';
import {
  Confidence,
  DecisionSource,
  Domain,
  Id,
  Language,
  PageHost,
  RiskLevel,
  Timestamp,
  WebUrl,
} from './primitives.js';

export const IntentKind = z.enum([
  'navigate',
  'search',
  'media_playback',
  'shopping',
  'compare_prices',
  'find_alternatives',
  'form_fill',
  'research',
  'extract',
  'summarize',
  'monitor',
  'tab_management',
  'bookmarks',
  'read_later',
  'save_page',
  'screenshot_walkthrough',
  'unknown',
]);
export type IntentKind = z.infer<typeof IntentKind>;

/** A structured constraint such as price <= 5000 INR. */
export const Constraint = z.strictObject({
  field: z.string().min(1).max(64),
  op: z.enum(['<', '<=', '=', '>=', '>', 'contains', 'not_contains']),
  value: z.union([z.string().max(256), z.number().finite()]),
  unit: z.string().max(16).nullable(),
});
export type Constraint = z.infer<typeof Constraint>;

export const Entity = z.strictObject({
  type: z.string().min(1).max(64),
  value: z.string().max(256),
});

/**
 * Where the destination of a task comes from (Phase 1 correction). Decided before any navigation.
 *   EXPLICIT_USER_TARGET — the user named a URL, domain or known website
 *   CURRENT_TAB          — the user explicitly said to work in this tab / page / here
 *   CURRENT_PAGE         — no site named; the page already open can satisfy the request
 *   RESOLVED_WEBSITE     — the agent resolved a website from a name (e.g. a brand) or the intent
 *   SEARCH_DISCOVERY     — a search engine, only as the last resort
 */
export const TargetSource = z.enum([
  'EXPLICIT_USER_TARGET',
  'CURRENT_TAB',
  'CURRENT_PAGE',
  'RESOLVED_WEBSITE',
  'SEARCH_DISCOVERY',
]);
export type TargetSource = z.infer<typeof TargetSource>;

export const NavigationPolicy = z.enum([
  'REUSE_CURRENT_CONTEXT',
  'DIRECT_NAVIGATE',
  'RESOLVE_WEBSITE',
  'SEARCH_AS_LAST_RESORT',
]);
export type NavigationPolicy = z.infer<typeof NavigationPolicy>;

/** Output of the intent resolver (spec §8). */
export const IntentProfile = z.strictObject({
  intent: IntentKind,
  targetDomain: Domain.nullable(),
  directNavigation: z.boolean(),
  action: z.string().max(64).nullable(),
  query: z.string().max(512).nullable(),
  constraints: z.array(Constraint).max(32),
  entities: z.array(Entity).max(64),
  language: Language,
  riskLevel: RiskLevel,
  requiresConfirmation: z.boolean(),
  confidence: Confidence,
  resolvedBy: DecisionSource,
  /** Proposed by the resolver from the wording; finalised by the navigation policy with the tab context. */
  targetSource: TargetSource,
  navigationPolicy: NavigationPolicy,
  /** A website named by the user that is not a URL/domain/known site (e.g. a brand), for resolution. */
  siteName: z.string().min(1).max(80).nullable(),
  /** "the first/second … result": 1-based position on the current results; null = best match. */
  ordinal: z.number().int().min(1).max(50).nullable(),
});
export type IntentProfile = z.infer<typeof IntentProfile>;

/** The "Intent" record attached to a task: the raw request plus its resolved profile. */
export const Intent = z.strictObject({
  taskId: Id,
  profile: IntentProfile,
  resolvedAt: Timestamp,
  latencyMs: z.number().nonnegative(),
});
export type Intent = z.infer<typeof Intent>;

/** Where the target router decided to go (spec §9). */
export const Target = z
  .strictObject({
    domain: PageHost,
    url: WebUrl,
    adapterId: Id.nullable(),
    reason: z.enum([
      'explicit-site',
      'current-tab',
      'resolved-website',
      'generic-search',
      'search-discovery',
      'research',
    ]),
  })
  // A site the agent navigates to must be a real domain; a local host or IP address is only
  // accepted for the tab the user already has open.
  .refine((t) => t.reason === 'current-tab' || Domain.safeParse(t.domain).success, {
    path: ['domain'],
    message: 'must be a lowercase hostname',
  });
export type Target = z.infer<typeof Target>;
