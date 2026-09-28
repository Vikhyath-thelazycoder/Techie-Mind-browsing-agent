import type { IntentProfile, SkillId, Target } from '@techie-mind/contracts';

/**
 * Goals are generic outcomes, not scripts. Each goal is achieved by the same loop:
 * observe → ground → bind → execute → observe result → verify → (bounded recovery).
 */
export type Goal =
  | { kind: 'use-context'; domain: string }
  | { kind: 'navigate'; url: string; domain: string }
  | { kind: 'search'; query: string }
  | {
      kind: 'open-result';
      /** Query the results were produced for; null = read it from the page (follow-up command). */
      query: string | null;
      media: boolean;
      /** 1-based position among the results; null = the best match. */
      ordinal: number | null;
    }
  | {
      kind: 'extract';
      /** Only items whose price satisfies these (from "under ₹50,000"). */
      maxPrice: number | null;
      minPrice: number | null;
    }
  | { kind: 'pick-item'; by: 'cheapest' | 'costliest' | 'top-rated' }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'history'; direction: 'back' | 'forward' }
  | { kind: 'add-to-cart' }
  | { kind: 'checkout'; target: 'cart' | 'checkout' }
  | { kind: 'fill-form' }
  | { kind: 'summarize' }
  | { kind: 'skill'; id: SkillId; arg: string }
  | {
      kind: 'open-element';
      /** Element id from the observation the model was shown (re-checked before binding). */
      elementId: string;
      /** What the model said the element is — shown to the user, never used to act. */
      label: string;
      media: boolean;
    };

/** Actions the Phase 1 core can carry out end to end. */
const SUPPORTED_ACTIONS = new Set([
  'navigate',
  'search',
  'search_and_play',
  'search_and_open',
  'play_result',
  'open_result',
  'open_element',
  'play_element',
  'pick_item',
  'scroll',
  'go_back',
  'go_forward',
  'add_to_cart',
  'checkout',
  'fill_form',
  'summarize',
]);

const commandParam = (profile: IntentProfile) =>
  profile.entities.find((e) => e.type === 'command')?.value ?? '';

/** Price bounds from the request's constraints ("under ₹50,000" → maxPrice 50000). */
export function priceBounds(profile: IntentProfile): {
  maxPrice: number | null;
  minPrice: number | null;
} {
  let maxPrice: number | null = null;
  let minPrice: number | null = null;
  for (const c of profile.constraints) {
    if (c.field !== 'price' || typeof c.value !== 'number') continue;
    if (c.op === '<' || c.op === '<=') maxPrice = c.value;
    if (c.op === '>' || c.op === '>=') minPrice = c.value;
    if (c.op === '=') maxPrice = minPrice = c.value;
  }
  return { maxPrice, minPrice };
}

/** Entity carrying the element a model picked for open_element / play_element. */
export const ELEMENT_ENTITY = 'element';
export const ELEMENT_LABEL_ENTITY = 'element_label';

export type PlanResult =
  { ok: true; goals: Goal[] } | { ok: false; code: 'UNSUPPORTED_INTENT'; message: string };

/**
 * @param reuse true when the task works in the already-open tab (no navigation goal).
 */
export function planGoals(profile: IntentProfile, target: Target, reuse = false): PlanResult {
  if (!profile.action || !SUPPORTED_ACTIONS.has(profile.action)) {
    return {
      ok: false,
      code: 'UNSUPPORTED_INTENT',
      message: `"${profile.action ?? profile.intent}" is not supported yet; the agent core currently handles opening websites, searching, and opening or playing results.`,
    };
  }
  const goals: Goal[] = [
    reuse
      ? { kind: 'use-context', domain: target.domain }
      : { kind: 'navigate', url: target.url, domain: target.domain },
  ];
  const action = profile.action;
  const page: Record<string, () => Goal> = {
    pick_item: () => ({
      kind: 'pick-item',
      by:
        (['cheapest', 'costliest', 'top-rated'] as const).find(
          (b) => b === commandParam(profile),
        ) ?? 'cheapest',
    }),
    scroll: () => ({ kind: 'scroll', direction: commandParam(profile) === 'up' ? 'up' : 'down' }),
    go_back: () => ({ kind: 'history', direction: 'back' }),
    go_forward: () => ({ kind: 'history', direction: 'forward' }),
    add_to_cart: () => ({ kind: 'add-to-cart' }),
    checkout: () => ({
      kind: 'checkout',
      target: commandParam(profile) === 'cart' ? 'cart' : 'checkout',
    }),
    fill_form: () => ({ kind: 'fill-form' }),
    summarize: () => ({ kind: 'summarize' }),
  };
  const pageGoal = page[action];
  if (pageGoal) {
    goals.push(pageGoal());
    return { ok: true, goals };
  }
  if (action === 'open_element' || action === 'play_element') {
    const elementId = profile.entities.find((e) => e.type === ELEMENT_ENTITY)?.value;
    if (!elementId) {
      return { ok: false, code: 'UNSUPPORTED_INTENT', message: 'No element was chosen.' };
    }
    goals.push({
      kind: 'open-element',
      elementId,
      label: profile.entities.find((e) => e.type === ELEMENT_LABEL_ENTITY)?.value ?? elementId,
      media: action === 'play_element',
    });
    return { ok: true, goals };
  }
  if (action === 'play_result' || action === 'open_result') {
    goals.push({
      kind: 'open-result',
      query: null,
      media: action === 'play_result',
      ordinal: profile.ordinal,
    });
    return { ok: true, goals };
  }
  if (profile.query && action !== 'navigate') {
    goals.push({ kind: 'search', query: profile.query });
    const bounds = priceBounds(profile);
    if (action === 'search' && (bounds.maxPrice !== null || bounds.minPrice !== null)) {
      // "laptops under ₹50,000": read the results and keep what fits (spec acceptance test 4).
      goals.push({ kind: 'extract', ...bounds });
    }
    if (action === 'search_and_play' || action === 'search_and_open') {
      goals.push({
        kind: 'open-result',
        query: profile.query,
        media: action === 'search_and_play',
        ordinal: profile.ordinal,
      });
    }
  }
  return { ok: true, goals };
}

const ORDINAL_NAMES = ['first', 'second', 'third', 'fourth', 'fifth'];

function ordinalName(n: number): string {
  return ORDINAL_NAMES[n - 1] ?? `#${n}`;
}

export function describeGoal(goal: Goal): string {
  switch (goal.kind) {
    case 'use-context':
      return `Use the current tab (${goal.domain})`;
    case 'navigate':
      return `Open ${goal.domain}`;
    case 'search':
      return `Search for "${goal.query}"`;
    case 'open-element':
      return `${goal.media ? 'Play' : 'Open'} "${goal.label}"`;
    case 'extract':
      return goal.maxPrice !== null
        ? `Read the results and keep those up to ${goal.maxPrice.toLocaleString('en-IN')}`
        : goal.minPrice !== null
          ? `Read the results and keep those from ${goal.minPrice.toLocaleString('en-IN')}`
          : 'Read the items on this page';
    case 'pick-item':
      return `Open the ${goal.by.replace('-', ' ')} item`;
    case 'scroll':
      return `Scroll ${goal.direction}`;
    case 'history':
      return goal.direction === 'back' ? 'Go back' : 'Go forward';
    case 'add-to-cart':
      return 'Add this item to the cart';
    case 'checkout':
      return goal.target === 'cart'
        ? 'Open the cart'
        : 'Go to checkout (the agent stops before payment)';
    case 'fill-form':
      return 'Fill this form from your saved profile (no submit)';
    case 'summarize':
      return 'Summarize this page';
    case 'skill':
      return `Skill: ${goal.id}${goal.arg ? ` (${goal.arg.slice(0, 80)})` : ''}`;
    case 'open-result': {
      const which = goal.ordinal ? `the ${ordinalName(goal.ordinal)} result` : 'the best result';
      const forQuery = goal.query ? ` for "${goal.query}"` : '';
      return goal.media ? `Play ${which}${forQuery}` : `Open ${which}${forQuery}`;
    }
  }
}
