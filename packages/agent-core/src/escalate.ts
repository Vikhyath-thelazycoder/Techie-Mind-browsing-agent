import {
  IntentProfile,
  type LayaClassification,
  type ModelInterpretation,
  type ModelTier,
  type SanitizedObservation,
} from '@techie-mind/contracts';
import { summarizeForModel } from '@techie-mind/models';
import { AMBIGUOUS_ENTITY, resolveIntent, UNSUPPORTED_ENTITY } from './intent.js';
import { ELEMENT_ENTITY, ELEMENT_LABEL_ENTITY } from './plan.js';
import { normalize } from './text.js';

/**
 * Tier routing rules (spec §21, plan §43). Code answers first; only a reading code is unsure of
 * goes to the model tiers, and whatever a model says is re-checked here before it becomes a plan.
 */

/** Code readings at or above this confidence never consult a model. */
export const CODE_CONFIDENCE = 0.8;
/** A Laya answer is used only when it is at least this sure and did not ask to escalate. */
export const LAYA_CONFIDENCE = 0.75;
/** A reasoning-model answer below this confidence is treated like an abstention. */
export const MODEL_CONFIDENCE = 0.5;

export function isAmbiguous(profile: IntentProfile): boolean {
  return profile.entities.some((e) => e.type === AMBIGUOUS_ENTITY);
}

export function isUnsupported(profile: IntentProfile): boolean {
  return profile.entities.some((e) => e.type === UNSUPPORTED_ENTITY);
}

/** Greetings and chit-chat: answered by the local model as text, never searched on the web. */
const SMALL_TALK =
  /^(?:hi|hii+|hello|hey|hola|namaste|namaskara|vanakkam|good\s+(?:morning|afternoon|evening|night)|how\s+are\s+you(?:\s+doing)?|how\s+r\s+u|how\s+is\s+it\s+going|what'?s\s+up|who\s+are\s+you|what\s+are\s+you|what\s+is\s+your\s+name|what'?s\s+your\s+name|what\s+can\s+you\s+do|who\s+(?:made|built|created)\s+you|thanks?(?:\s+you)?|thank\s+you(?:\s+so\s+much)?|ok(?:ay)?\s+thanks?|nice|cool|great|bye|good\s*bye|see\s+you|kaise\s+ho|kaisa\s+hai|hegiddira|hegidiya|chennagiddira|epdi\s+irukinga|ela\s+unnaru)(?:\s+(?:bro|buddy|there|techie(?:\s+mind)?))?[\s!?.,]*$/iu;

export function isSmallTalk(text: string): boolean {
  return SMALL_TALK.test(text.trim());
}

/** Indian-language command and grammar words that must never end up inside a search query. */
const LEFTOVER_WORDS =
  /(?:^|\s)(?:maadi|maadu|madi|madu|karo|kar|kardo|karna|pe|par|se|kam|mein|alli|nalli|hogu|jao|kholo|dhoondo|dhundo|huduku|chalao|bajao|haaku|hakko|beku|chahiye)(?=\s|$)/iu;

/** Should this reading be checked by the model tiers? */
export function needsModel(profile: IntentProfile): boolean {
  if (isUnsupported(profile)) return false;
  // Rules left Indian-language words in the query: let the local model read (translate) it.
  if (profile.language !== 'en' && profile.query && LEFTOVER_WORDS.test(profile.query)) return true;
  return profile.intent === 'unknown' || profile.confidence < CODE_CONFIDENCE;
}

export type LayaVerdict =
  { kind: 'accept-code' } | { kind: 'page-command' } | { kind: 'escalate'; reason: string };

/**
 * Laya is a typed decision: it can confirm the code's plain-search reading or recognise a page
 * command, which are the cases where it saves a 7B call. Everything else goes up a tier.
 */
export function judgeLaya(value: LayaClassification | null, code: IntentProfile): LayaVerdict {
  if (!value) return { kind: 'escalate', reason: 'no Laya answer' };
  if (value.escalate) return { kind: 'escalate', reason: 'Laya passed it up' };
  if (value.confidence < LAYA_CONFIDENCE) {
    return { kind: 'escalate', reason: `Laya unsure (${value.confidence.toFixed(2)})` };
  }
  if (value.category === 'page_command') return { kind: 'page-command' };
  if (value.category === 'search' && code.action === 'search' && code.query && !isAmbiguous(code)) {
    return { kind: 'accept-code' };
  }
  return { kind: 'escalate', reason: `Laya: ${value.category} needs interpretation` };
}

const words = (text: string) =>
  normalize(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);

/** The phrase appears in the user's own words (in order, whole words). */
export function fromUserWords(phrase: string, userText: string): boolean {
  const p = words(phrase);
  const u = words(userText);
  if (p.length === 0) return false;
  for (let i = 0; i + p.length <= u.length; i++) {
    if (p.every((w, j) => u[i + j] === w)) return true;
  }
  return false;
}

export type ModelMapping =
  { ok: true; profile: IntentProfile; label: string | null } | { ok: false; reason: string };

/**
 * Turn a model interpretation into an intent profile — or refuse it. Code, not the model, decides:
 *   - a query must be the user's own words (a model cannot invent what gets typed),
 *   - a site must be named in the user's words and is resolved by the deterministic router,
 *   - an element must be one of the interactive elements the model was actually shown.
 */
export function profileFromModel(
  interp: ModelInterpretation,
  code: IntentProfile,
  modelText: string,
  shown: SanitizedObservation | null,
  tier: ModelTier,
): ModelMapping {
  if (interp.kind === 'abstain') return { ok: false, reason: 'the model abstained' };
  if (interp.kind === 'chat') return { ok: false, reason: 'a chat reply is not a browsing task' };
  if (interp.confidence < MODEL_CONFIDENCE) {
    return { ok: false, reason: `model unsure (${interp.confidence.toFixed(2)})` };
  }
  const resolvedBy = tier === 'api' ? 'api' : 'qwen';
  const base = {
    ...code,
    constraints: code.constraints,
    riskLevel: code.riskLevel,
    requiresConfirmation: code.requiresConfirmation,
    confidence: interp.confidence,
    resolvedBy,
  } as const;

  if (interp.kind === 'element') {
    const summary = shown ? summarizeForModel(shown) : null;
    const node = summary?.nodes.find((n) => n.nodeId === interp.elementId);
    if (!node)
      return { ok: false, reason: `element ${interp.elementId} was not on the page shown` };
    if (!node.interactive)
      return { ok: false, reason: `element ${interp.elementId} is not clickable` };
    const label = (node.name ?? node.text ?? interp.elementId).slice(0, 120);
    return {
      ok: true,
      label,
      profile: IntentProfile.parse({
        ...base,
        intent: interp.media ? 'media_playback' : 'navigate',
        action: interp.media ? 'play_element' : 'open_element',
        query: null,
        entities: [
          { type: ELEMENT_ENTITY, value: interp.elementId },
          { type: ELEMENT_LABEL_ENTITY, value: label },
        ],
        targetDomain: null,
        directNavigation: false,
        siteName: null,
        ordinal: null,
        targetSource: 'CURRENT_PAGE',
        navigationPolicy: 'REUSE_CURRENT_CONTEXT',
      }),
    };
  }

  const needsQuery = interp.action === 'search' || interp.action === 'search_and_play';
  if (needsQuery && !interp.query) return { ok: false, reason: 'no query for a search' };
  if (interp.query && !fromUserWords(interp.query, modelText)) {
    return { ok: false, reason: 'the query is not in the user request' };
  }
  let targetDomain: string | null = null;
  let siteName: string | null = null;
  if (interp.site) {
    if (!fromUserWords(interp.site, modelText)) {
      return { ok: false, reason: 'the site is not named in the user request' };
    }
    const routed = resolveIntent(`open ${interp.site}`).profile;
    targetDomain = routed.targetDomain;
    siteName = routed.siteName;
    if (!targetDomain && !siteName) return { ok: false, reason: 'the site could not be routed' };
  }
  if (interp.action === 'navigate' && !targetDomain && !siteName) {
    return { ok: false, reason: 'no website to open' };
  }
  const pick = interp.action === 'open_result' || interp.action === 'play_result';
  const media = interp.action === 'search_and_play' || interp.action === 'play_result';
  const targetSource = targetDomain
    ? 'EXPLICIT_USER_TARGET'
    : siteName
      ? 'RESOLVED_WEBSITE'
      : 'CURRENT_PAGE';
  return {
    ok: true,
    label: null,
    profile: IntentProfile.parse({
      ...base,
      intent: media ? 'media_playback' : interp.action === 'navigate' ? 'navigate' : 'search',
      action: interp.action,
      query: pick ? null : interp.query,
      entities: [
        ...(targetDomain ? [{ type: 'site', value: targetDomain }] : []),
        ...(siteName ? [{ type: 'site_name', value: siteName }] : []),
        ...(interp.query && !pick ? [{ type: 'query', value: interp.query.slice(0, 256) }] : []),
      ],
      targetDomain,
      directNavigation: targetDomain !== null,
      siteName,
      ordinal: pick ? interp.ordinal : null,
      targetSource,
      navigationPolicy: targetDomain
        ? 'DIRECT_NAVIGATE'
        : siteName
          ? 'RESOLVE_WEBSITE'
          : 'REUSE_CURRENT_CONTEXT',
    }),
  };
}
