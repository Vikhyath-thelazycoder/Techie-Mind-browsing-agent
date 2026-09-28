import {
  VisualLocation,
  LayaClassification,
  ModelInterpretation,
  RequestCategory,
  type ModelIntentAction,
} from '@techie-mind/contracts';

/**
 * Model output is untrusted text. It is accepted only when it is ONE JSON object whose keys are all
 * known and whose values fit the contract; anything else is `null` (outcome "invalid") and is never
 * acted on. Nothing is repaired or guessed.
 */

const FLAT_KEYS = new Set([
  'kind',
  'action',
  'site',
  'query',
  'ordinal',
  'elementId',
  'media',
  'question',
  'confidence',
  'reason',
]);

function asObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text.startsWith('{') || !text.endsWith('}') || text.length > 8_000) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const blank = (v: unknown) => v === null || v === undefined || v === '';

/** Parse the flat JSON object the reasoning model emits into a strict ModelInterpretation. */
export function parseInterpretation(raw: unknown): ModelInterpretation | null {
  const o = asObject(raw);
  if (!o || Object.keys(o).some((k) => !FLAT_KEYS.has(k))) return null;
  const reason = typeof o['reason'] === 'string' ? o['reason'].slice(0, 500) : '';
  let candidate: unknown;
  if (o['kind'] === 'intent') {
    candidate = {
      kind: 'intent',
      action: o['action'] as ModelIntentAction,
      site: blank(o['site']) ? null : o['site'],
      query: blank(o['query']) ? null : o['query'],
      ordinal: blank(o['ordinal']) ? null : o['ordinal'],
      confidence: o['confidence'],
      reason,
    };
  } else if (o['kind'] === 'element') {
    candidate = {
      kind: 'element',
      elementId: o['elementId'],
      media: o['media'] === true,
      confidence: o['confidence'],
      reason,
    };
  } else if (o['kind'] === 'abstain') {
    candidate = {
      kind: 'abstain',
      question:
        typeof o['question'] === 'string' && o['question'].trim()
          ? o['question'].slice(0, 500)
          : 'Could you say that another way?',
      reason,
    };
  } else {
    return null;
  }
  const parsed = ModelInterpretation.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Parse the Laya adapter's typed answer. */
export function parseClassification(raw: unknown): LayaClassification | null {
  const o = asObject(raw);
  if (!o) return null;
  const parsed = LayaClassification.safeParse({
    category: o['category'],
    confidence: o['confidence'],
    escalate: o['escalate'],
  });
  return parsed.success ? parsed.data : null;
}

export const CATEGORIES = RequestCategory.options;

/** Parse a vision answer; the box must lie inside the image and have a positive area. */
export function parseLocation(raw: unknown, width: number, height: number): VisualLocation | null {
  const o = asObject(raw);
  if (
    !o ||
    Object.keys(o).some((k) => !['found', 'box', 'label', 'confidence', 'reason'].includes(k))
  ) {
    return null;
  }
  if (o['found'] === false) {
    const parsed = VisualLocation.safeParse({
      found: false,
      reason: typeof o['reason'] === 'string' ? o['reason'].slice(0, 500) : 'not visible',
    });
    return parsed.success ? parsed.data : null;
  }
  const parsed = VisualLocation.safeParse({
    found: o['found'],
    box: o['box'],
    label: typeof o['label'] === 'string' ? o['label'].slice(0, 200) : '',
    confidence: o['confidence'],
  });
  if (!parsed.success || !parsed.data.found) return null;
  const [x1, y1, x2, y2] = parsed.data.box;
  const inside = x2 <= width + 1 && y2 <= height + 1;
  if (!(x2 > x1 && y2 > y1) || !inside) return null;
  return parsed.data;
}
