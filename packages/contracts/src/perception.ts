import { z } from 'zod';
import { BoundingBox, Confidence, Id, Origin, Timestamp, WebUrl } from './primitives.js';

/**
 * Derived attributes the DOM observer adds to `DOMNode.attributes` (prefixed so they can never
 * collide with real HTML attributes). Grounding reads them; they carry no page secrets.
 */
export const DERIVED_ATTR = {
  /** Role of the owning form: "search" for <form role=search> or a <search> ancestor. */
  formRole: 'tm:form-role',
  /** Owning form's action URL path (no query string). */
  formAction: 'tm:form-action',
  /** Nearest landmark: banner, navigation, main, search, contentinfo, complementary, dialog. */
  landmark: 'tm:landmark',
} as const;

/** One element captured by the local DOM observer (perception level 1). */
export const DOMNode = z.strictObject({
  nodeId: Id,
  parentId: Id.nullable(),
  tag: z.string().min(1).max(64),
  role: z.string().max(64).nullable(),
  name: z.string().max(512).nullable(),
  text: z.string().max(2000).nullable(),
  attributes: z.record(z.string().max(64), z.string().max(1024)),
  inputType: z.string().max(32).nullable(),
  /** Id of the owning form's node-group (shared by inputs/buttons of one form), if any. */
  formId: Id.nullable(),
  /** Current value of an editable control. Local-only: observations never leave the browser. */
  value: z.string().max(2000).nullable(),
  visible: z.boolean(),
  interactive: z.boolean(),
  editable: z.boolean(),
  bbox: BoundingBox.nullable(),
});
export type DOMNode = z.infer<typeof DOMNode>;

/** One accessibility-tree node (perception level 2). */
export const AccessibilityNode = z.strictObject({
  nodeId: Id,
  domNodeId: Id.nullable(),
  role: z.string().min(1).max(64),
  name: z.string().max(512),
  value: z.string().max(1024).nullable(),
  states: z.array(z.string().max(32)).max(32),
  childIds: z.array(Id).max(1000),
});
export type AccessibilityNode = z.infer<typeof AccessibilityNode>;

/** A region produced by the on-demand local visual model (perception level 4). */
export const VisualRegion = z.strictObject({
  regionId: Id,
  bbox: BoundingBox,
  label: z.string().max(256),
  confidence: Confidence,
  source: z.enum(['vision-model', 'ocr']),
  domNodeId: Id.nullable(),
});
export type VisualRegion = z.infer<typeof VisualRegion>;

export const Viewport = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scrollX: z.number().finite(),
  scrollY: z.number().finite(),
  devicePixelRatio: z.number().positive(),
});
export type Viewport = z.infer<typeof Viewport>;

/**
 * A versioned, local-only snapshot of a page. It may contain raw page content and therefore
 * never crosses the network boundary; only SanitizedObservation may (spec §13, §17).
 */
export const Observation = z.strictObject({
  observationId: Id,
  taskId: Id,
  tabId: z.number().int().nonnegative(),
  documentId: Id,
  origin: Origin,
  url: WebUrl,
  title: z.string().max(512),
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  viewport: Viewport,
  domNodes: z.array(DOMNode).max(5000),
  a11yNodes: z.array(AccessibilityNode).max(5000),
  visualRegions: z.array(VisualRegion).max(500),
});
export type Observation = z.infer<typeof Observation>;
