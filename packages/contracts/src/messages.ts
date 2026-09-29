import { z } from 'zod';
import { Action } from './action.js';
import { Observation } from './perception.js';
import { BoundingBox, Id, ShortText, Timestamp } from './primitives.js';

/**
 * Internal extension messaging protocol. Every message crossing a context boundary
 * (side panel ↔ service worker ↔ content script) is parsed against these schemas;
 * anything unrecognised is rejected.
 */
export const HealthRequest = z.strictObject({ type: z.literal('HEALTH_REQUEST') });

export const HealthResponse = z.strictObject({
  type: z.literal('HEALTH_RESPONSE'),
  ok: z.literal(true),
  component: z.literal('background'),
  browser: z.enum(['chrome', 'firefox']),
  version: z.string().max(32),
  startedAt: Timestamp,
  uptimeMs: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const OpenSettingsRequest = z.strictObject({ type: z.literal('OPEN_SETTINGS') });

export const OkResponse = z.strictObject({ type: z.literal('OK'), ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Messages the background service worker accepts from extension pages (one-shot). */
export const BackgroundRequest = z.discriminatedUnion('type', [HealthRequest, OpenSettingsRequest]);
export type BackgroundRequest = z.infer<typeof BackgroundRequest>;

export const ErrorResponse = z.strictObject({
  type: z.literal('ERROR'),
  ok: z.literal(false),
  code: z.enum(['INVALID_MESSAGE', 'UNTRUSTED_SENDER', 'INTERNAL']),
  message: z.string().max(500),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

// ── Content-script protocol (background → content script in the agent's tab) ─────────────────

export const ContentPing = z.strictObject({ type: z.literal('CONTENT_PING') });

export const ContentPong = z.strictObject({
  type: z.literal('CONTENT_PONG'),
  ok: z.literal(true),
  origin: z.string().max(512),
  documentId: Id,
  readyState: z.enum(['loading', 'interactive', 'complete']),
});
export type ContentPong = z.infer<typeof ContentPong>;

/** Capture a local DOM/A11y observation of the current document. */
export const ObserveCommand = z.strictObject({
  type: z.literal('OBSERVE'),
  taskId: Id,
  observationId: Id,
  /** The content script cannot know its own tab id; the background supplies it. */
  tabId: z.number().int().nonnegative(),
});

export const ObserveResponse = z.strictObject({
  type: z.literal('OBSERVATION'),
  observation: Observation,
});
export type ObserveResponse = z.infer<typeof ObserveResponse>;

/** Execute one bound, validated action. The content script re-validates binding and schema. */
export const ExecuteCommand = z.strictObject({
  type: z.literal('EXECUTE'),
  action: Action,
  /**
   * The value of the action's vault token (TYPE with `vaultToken`), resolved by the background at the
   * last hop so the Action itself never carries personal data. The page is the user's own
   * destination for it; it is never logged.
   */
  resolved: z
    .strictObject({ vaultToken: z.string().max(40), text: z.string().max(2000) })
    .optional(),
  /** The user's attached file for an UPLOAD action (matched by `fileRef`). */
  file: z
    .strictObject({
      fileRef: z.string().max(128),
      name: z.string().max(255),
      mime: z.string().max(128),
      base64: z.string().max(14_000_000),
    })
    .optional(),
});

export const ExecuteRejection = z.enum([
  'INVALID_ACTION',
  'DOCUMENT_MISMATCH',
  'ORIGIN_MISMATCH',
  'STALE_OBSERVATION',
  'TARGET_MISSING',
  'TARGET_CHANGED',
  'TARGET_HIDDEN',
  'TARGET_DISABLED',
  'TARGET_NOT_EDITABLE',
  'TARGET_DETACHED',
  'UNSUPPORTED_ACTION',
]);
export type ExecuteRejection = z.infer<typeof ExecuteRejection>;

export const ExecuteResponse = z.strictObject({
  type: z.literal('EXECUTE_RESULT'),
  actionId: Id,
  status: z.enum(['executed', 'rejected', 'failed']),
  code: ExecuteRejection.nullable(),
  message: ShortText,
  /** Field value read back after TYPE/CLEAR/SELECT (local verification). */
  valueAfter: z.string().max(2000).nullable(),
  versionAfter: z.number().int().nonnegative(),
  /** True when a navigation-capable side effect (submit/click) was scheduled after this response. */
  deferred: z.boolean(),
});
export type ExecuteResponse = z.infer<typeof ExecuteResponse>;

/** Cheap page-state probe used for settling and verification. */
export const ProbeCommand = z.strictObject({ type: z.literal('PROBE'), elementId: Id.nullable() });

/** Whole-page privacy scan, run inside the page. The reply carries counts only — never text. */
export const PrivacyScanCommand = z.strictObject({ type: z.literal('PRIVACY_SCAN') });

export const PrivacyScanResponse = z.strictObject({
  type: z.literal('PRIVACY_SCAN_RESULT'),
  documentId: Id,
  total: z.number().int().nonnegative(),
  byKind: z.record(z.string().max(32), z.number().int().nonnegative()),
  fields: z.number().int().nonnegative(),
  /** Rendered text blocks that try to instruct the agent (reported, never obeyed). */
  injections: z.number().int().nonnegative(),
  textChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
  ms: z.number().nonnegative(),
});
export type PrivacyScanResponse = z.infer<typeof PrivacyScanResponse>;

/**
 * Where sensitive content is on screen (Phase 4, visual privacy). Run inside the page right before a
 * screenshot: the reply carries rectangles in viewport CSS pixels and counts — never text.
 */
export const PrivacyRegionsCommand = z.strictObject({
  type: z.literal('PRIVACY_REGIONS'),
  /** Also cover images that look like photos of people (settings: face blurring). */
  people: z.boolean(),
});

export const PrivacyRegionsResponse = z.strictObject({
  type: z.literal('PRIVACY_REGIONS_RESULT'),
  documentId: Id,
  regions: z
    .array(
      z.strictObject({
        box: BoundingBox,
        reason: z.enum(['text', 'field', 'person']),
      }),
    )
    .max(500),
  viewport: z.strictObject({
    width: z.number().positive(),
    height: z.number().positive(),
    scrollX: z.number().finite(),
    scrollY: z.number().finite(),
    devicePixelRatio: z.number().positive(),
  }),
  ms: z.number().nonnegative(),
});
export type PrivacyRegionsResponse = z.infer<typeof PrivacyRegionsResponse>;

// ── Phase 5: extraction and trusted input ─────────────────────────────────────────────────────

/** One repeated item on a results/listing page (a product card, a search hit). */
export const ExtractedItem = z.strictObject({
  /** The item's link element (registry id), so it can be opened like any grounded element. */
  elementId: Id,
  title: z.string().max(300),
  price: z.number().nonnegative().nullable(),
  currency: z.enum(['INR', 'USD', 'EUR', 'GBP']).nullable(),
  rating: z.number().min(0).max(5).nullable(),
  /** 1-based position in reading order. */
  position: z.number().int().positive(),
});
export type ExtractedItem = z.infer<typeof ExtractedItem>;

export const ExtractItemsCommand = z.strictObject({ type: z.literal('EXTRACT_ITEMS') });
export const ExtractItemsResponse = z.strictObject({
  type: z.literal('ITEMS_RESULT'),
  documentId: Id,
  items: z.array(ExtractedItem).max(100),
  ms: z.number().nonnegative(),
});
export type ExtractItemsResponse = z.infer<typeof ExtractItemsResponse>;

/** Main readable content of the page (for summaries). Stays local until redacted. */
export const ExtractTextCommand = z.strictObject({ type: z.literal('EXTRACT_TEXT') });
export const ExtractTextResponse = z.strictObject({
  type: z.literal('TEXT_RESULT'),
  documentId: Id,
  title: z.string().max(512),
  headings: z.array(z.string().max(300)).max(40),
  paragraphs: z.array(z.string().max(2000)).max(200),
  /** Data tables on the page (first rows only). */
  tables: z
    .array(
      z.strictObject({
        headers: z.array(z.string().max(200)).max(30),
        rows: z.array(z.array(z.string().max(500)).max(30)).max(200),
      }),
    )
    .max(10)
    .default([]),
  truncated: z.boolean(),
  ms: z.number().nonnegative(),
});
export type ExtractTextResponse = z.infer<typeof ExtractTextResponse>;

/** Where a bound element is on screen right now (for a trusted click at its centre). */
export const ElementRectCommand = z.strictObject({
  type: z.literal('ELEMENT_RECT'),
  elementId: Id,
});
export const ElementRectResponse = z.strictObject({
  type: z.literal('ELEMENT_RECT_RESULT'),
  documentId: Id,
  visible: z.boolean(),
  /** Viewport CSS pixels, after scrolling the element into view. */
  rect: BoundingBox.nullable(),
});
export type ElementRectResponse = z.infer<typeof ElementRectResponse>;

export const ProbeResponse = z.strictObject({
  type: z.literal('PROBE_RESULT'),
  url: z.string().max(2048),
  origin: z.string().max(512),
  title: z.string().max(512),
  documentId: Id,
  version: z.number().int().nonnegative(),
  readyState: z.enum(['loading', 'interactive', 'complete']),
  element: z
    .strictObject({
      exists: z.boolean(),
      visible: z.boolean(),
      value: z.string().max(2000).nullable(),
    })
    .nullable(),
  /**
   * Primary media = the largest visible <video>/<audio> on the page (ignores hidden/tiny preview
   * players). `playing` and `currentTime` describe that element only.
   */
  media: z.strictObject({
    present: z.boolean(),
    playing: z.boolean(),
    currentTime: z.number().nonnegative().nullable(),
  }),
});
export type ProbeResponse = z.infer<typeof ProbeResponse>;

/** Messages the content script accepts from its own background. */
export const ContentRequest = z.discriminatedUnion('type', [
  ContentPing,
  ObserveCommand,
  ExecuteCommand,
  ProbeCommand,
  PrivacyScanCommand,
  PrivacyRegionsCommand,
  ExtractItemsCommand,
  ExtractTextCommand,
  ElementRectCommand,
]);
export type ContentRequest = z.infer<typeof ContentRequest>;

export const ContentResponse = z.union([
  ContentPong,
  ObserveResponse,
  ExecuteResponse,
  ProbeResponse,
  PrivacyScanResponse,
  PrivacyRegionsResponse,
  ExtractItemsResponse,
  ExtractTextResponse,
  ElementRectResponse,
  ErrorResponse,
]);
export type ContentResponse = z.infer<typeof ContentResponse>;
