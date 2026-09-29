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
  'reply',
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
  const r = readInterpretation(raw);
  return 'value' in r ? r.value : null;
}

/**
 * Which check an unusable answer failed — structure only (never the answer's text or key names),
 * so it is safe to put in logs and the activity timeline. Null when the answer is valid.
 */
export function whyInvalid(raw: unknown): string | null {
  const r = readInterpretation(raw);
  return 'why' in r ? r.why : null;
}

const RESULT_ACTIONS = new Set(['open_result', 'play_result']);

function readInterpretation(raw: unknown): { value: ModelInterpretation } | { why: string } {
  const o = asObject(raw);
  if (!o) return { why: 'not one JSON object' };
  const unknownKeys = Object.keys(o).filter((k) => !FLAT_KEYS.has(k)).length;
  if (unknownKeys) return { why: `unknown keys (${unknownKeys})` };
  const reason = typeof o['reason'] === 'string' ? o['reason'].slice(0, 500) : '';
  let candidate: unknown;
  // qwen2.5vl often labels an element pick as an "open/play the result" intent and names the element
  // in the same object. That is an element pick; profileFromModel still checks it was shown.
  const namedElement =
    o['kind'] === 'intent' &&
    RESULT_ACTIONS.has(String(o['action'])) &&
    typeof o['elementId'] === 'string' &&
    o['elementId'] !== '';
  if (namedElement) {
    candidate = {
      kind: 'element',
      elementId: o['elementId'],
      media: o['action'] === 'play_result' || o['media'] === true,
      confidence: o['confidence'],
      reason,
    };
  } else if (o['kind'] === 'intent') {
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
  } else if (o['kind'] === 'chat') {
    candidate = {
      kind: 'chat',
      reply: typeof o['reply'] === 'string' ? o['reply'].slice(0, 600) : '',
      confidence: o['confidence'],
      reason,
    };
  } else {
    return { why: 'unknown kind' };
  }
  const parsed = ModelInterpretation.safeParse(candidate);
  if (parsed.success) return { value: parsed.data };
  const issue = parsed.error.issues[0];
  return { why: `schema: ${issue?.path.join('.') || 'answer'} ${issue?.code ?? 'invalid'}` };
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

/** A summary answer: one JSON object with a bounded "summary" string and nothing else. */
export function parseSummary(raw: unknown): string | null {
  const o = asObject(raw);
  if (!o || Object.keys(o).some((k) => k !== 'summary')) return null;
  const text = o['summary'];
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 4000
    ? text.trim()
    : null;
}
