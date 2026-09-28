import type { Observation, ProbeResponse } from '@techie-mind/contracts';
import { groundResults } from './grounding.js';
import { hostMatchesDomain } from './sites.js';
import { allTermsIn, decodeUrlForMatching, normalize, tokenize } from './text.js';

/**
 * Post-action verification (spec §28). Success is decided from the observed page state after the
 * action — never from the fact that an action was dispatched.
 */
export interface Verdict {
  verified: boolean;
  evidence: string;
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function verifyNavigation(domain: string, after: ProbeResponse | null): Verdict {
  if (!after) return { verified: false, evidence: 'tab shows no web page after navigation' };
  const host = hostname(after.url);
  if (host && hostMatchesDomain(host, domain)) {
    // Hosts only: page titles are page content and can carry personal data (never logged).
    return { verified: true, evidence: `on ${host}` };
  }
  return { verified: false, evidence: `expected ${domain}, landed on ${host ?? after.url}` };
}

/** The field now holds the query (whitespace/case-insensitive). */
export function fieldHoldsQuery(value: string | null, query: string): boolean {
  return value !== null && normalize(value) === normalize(query);
}

export interface SearchVerdict extends Verdict {
  relevantResults: number;
}

/**
 * A search is verified when the page moved to a result state for THIS query:
 *   (a) the URL changed and carries every query term, or the new title does; and relevant result
 *       links are visible (or the page itself is the single matching result), or
 *   (b) an in-page search: URL unchanged, the field still holds the query, and more relevant
 *       results are visible than before.
 */
export function verifySearch(input: {
  query: string;
  before: ProbeResponse;
  beforeObs: Observation;
  after: ProbeResponse;
  afterObs: Observation;
}): SearchVerdict {
  const terms = tokenize(input.query);
  const relevantAfter = groundResults(input.afterObs, input.query).length;
  const relevantBefore = groundResults(input.beforeObs, input.query).length;
  const urlChanged = input.after.url !== input.before.url;
  const queryInUrl = allTermsIn(decodeUrlForMatching(input.after.url), terms);
  const queryInTitle = allTermsIn(input.after.title, terms);
  const fieldHasQuery = input.afterObs.domNodes.some(
    (n) => n.editable && fieldHoldsQuery(n.value, input.query),
  );

  if (urlChanged && (queryInUrl || queryInTitle) && (relevantAfter > 0 || queryInTitle)) {
    return {
      verified: true,
      relevantResults: relevantAfter,
      evidence: `results page ${shorten(input.after.url)} · ${relevantAfter} relevant results${queryInUrl ? ' · query in URL' : ''}`,
    };
  }
  if (!urlChanged && fieldHasQuery && relevantAfter > relevantBefore) {
    return {
      verified: true,
      relevantResults: relevantAfter,
      evidence: `in-page results updated: ${relevantBefore} → ${relevantAfter} relevant results`,
    };
  }
  return {
    verified: false,
    relevantResults: relevantAfter,
    evidence: urlChanged
      ? `page changed to ${shorten(input.after.url)} but it does not show results for the query`
      : 'page did not change after submitting the search',
  };
}

/**
 * Sustained playback: the page's primary media was playing in two probes taken apart in time and
 * its position advanced. A single "not paused" sample is not enough — preview players and trailers
 * start and stop on their own.
 */
export function isSustainedPlayback(
  first: ProbeResponse,
  second: ProbeResponse,
  minAdvanceS = 0.5,
): boolean {
  return (
    first.url === second.url &&
    first.media.playing &&
    second.media.playing &&
    first.media.currentTime !== null &&
    second.media.currentTime !== null &&
    second.media.currentTime - first.media.currentTime >= minAdvanceS
  );
}

export function verifyOpenResult(input: {
  before: ProbeResponse;
  after: ProbeResponse | null;
  media: boolean;
  /** Second probe taken after a delay, for media goals. */
  later?: ProbeResponse | null;
}): Verdict {
  const { after } = input;
  if (!after) return { verified: false, evidence: 'tab shows no web page after opening result' };
  if (after.url === input.before.url) {
    return { verified: false, evidence: 'clicking the result did not open a new page' };
  }
  if (input.media) {
    if (!after.media.present)
      return {
        verified: false,
        evidence: `opened ${shorten(after.url)} but it has no main media player`,
      };
    if (!input.later || !isSustainedPlayback(after, input.later)) {
      return {
        verified: false,
        evidence: `opened ${shorten(after.url)} but its media is not playing`,
      };
    }
    const advanced = (input.later.media.currentTime ?? 0) - (after.media.currentTime ?? 0);
    return {
      verified: true,
      evidence: `playing ${shorten(after.url)} · position advanced ${advanced.toFixed(1)} s`,
    };
  }
  return { verified: true, evidence: `opened ${shorten(after.url)}` };
}

function shorten(url: string): string {
  return url.length > 90 ? `${url.slice(0, 87)}…` : url;
}

/** Human-verification / bot-wall wording (CAPTCHA, "unusual traffic", access checks). */
const CHALLENGE_TEXT =
  /captcha|unusual traffic|not a robot|are you (?:a )?(?:robot|human)|verify (?:that )?you(?:'re| are) (?:a )?human|access denied|attention required|just a moment|checking your browser|request blocked/i;
const CHALLENGE_PATH = /\/(?:sorry|captcha|challenge|cdn-cgi\/challenge-platform)(?:\/|$)/i;

/**
 * The page is a CAPTCHA or bot-protection interstitial, not the site's content. Such pages are
 * always handed to the human (spec: CAPTCHA → handover) and never count as a verified result.
 * Wording that is part of the user's own query ("captcha solver") is not treated as a challenge.
 */
export function isChallengePage(
  probe: ProbeResponse,
  obs: Observation | null,
  query: string | null = null,
): boolean {
  let path = '';
  try {
    path = new URL(probe.url).pathname;
  } catch {
    path = '';
  }
  if (CHALLENGE_PATH.test(path)) return true;
  const own = (text: string) => {
    const m = CHALLENGE_TEXT.exec(text);
    return m !== null && !(query && normalize(query).includes(m[0].toLowerCase()));
  };
  if (own(probe.title)) return true;
  if (!obs) return false;
  return obs.domNodes.some(
    (n) =>
      (n.visible &&
        (n.role === 'heading' || n.tag === 'h1') &&
        own(`${n.name ?? ''} ${n.text ?? ''}`)) ||
      (n.tag === 'iframe' &&
        /recaptcha|hcaptcha|challenges\.cloudflare/i.test(n.attributes['src'] ?? '')),
  );
}

export function challengeMessage(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  return `${host} is showing a human-verification (CAPTCHA / access check) page. Complete it in the tab, then run the task again.`;
}
