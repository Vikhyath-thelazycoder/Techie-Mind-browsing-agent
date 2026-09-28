import {
  Target,
  type IntentProfile,
  type NavigationPolicy,
  type TargetSource,
} from '@techie-mind/contracts';
import { UNSUPPORTED_ENTITY, wantsCurrentTab } from './intent.js';
import {
  DEFAULT_MEDIA_SITE,
  DEFAULT_SEARCH_SITE,
  hostMatchesDomain,
  siteById,
  siteForDomain,
} from './sites.js';
import { brandLabels, domainLabel, registrableDomain } from './website.js';

/**
 * Navigation policy (Phase 1 correction). Decides WHERE a task acts before anything navigates, in
 * this priority:
 *   1. an explicit current-tab / current-page request            → reuse (or navigate THIS tab)
 *   2. an explicit URL or domain                                  → direct navigation
 *   3. a named website (known site or any brand name)             → direct / resolve the website
 *   4. the page already open, when it can satisfy the request     → reuse
 *   5. an intent default (playback → the default media site)      → direct navigation
 *   6. a search engine                                            → only as the last resort
 * A tab that is already on the requested site is reused instead of being reloaded.
 */

/** The browser tab that was in front of the user when the task started. */
export interface TabContext {
  tabId: number;
  url: string;
  origin: string;
  host: string;
  title: string;
  /** Active tab, or the tab the agent last worked in when the active tab is not a web page. */
  source: 'active-tab' | 'agent-tab';
}

/** What the open page can do, from one observation of it (only computed when it matters). */
export interface ContextFit {
  canSearch: boolean;
  hasMedia: boolean;
}

export type NavigationDecisionResult =
  | {
      ok: true;
      targetSource: TargetSource;
      navigationPolicy: NavigationPolicy;
      /** Work in the context tab without navigating it. */
      reuse: boolean;
      /** Navigate the context tab itself (explicit "in this tab, open …"). */
      inContextTab: boolean;
      /** Where to go (or where we are, when reusing). Null only while a website is being resolved. */
      target: Target | null;
      /** Name to resolve into a website (RESOLVE_WEBSITE). */
      resolveName: string | null;
      reason: string;
    }
  | {
      ok: false;
      code: 'NO_TARGET' | 'CURRENT_TAB_UNAVAILABLE' | 'NO_RESULTS_CONTEXT' | 'UNSUPPORTED_COMMAND';
      message: string;
    };

const SEARCH_ACTIONS = new Set(['search', 'search_and_play', 'search_and_open']);
const RESULT_ACTIONS = new Set([
  'play_result',
  'open_result',
  'open_element',
  'play_element',
  // Phase 5 page commands: they act on the page already open.
  'pick_item',
  'scroll',
  'go_back',
  'go_forward',
  'add_to_cart',
  'checkout',
  'fill_form',
  'summarize',
]);

/** True when the decision depends on what the open page can do (needs one observation). */
export function needsContextFit(profile: IntentProfile, context: TabContext | null): boolean {
  return (
    context !== null &&
    !wantsCurrentTab(profile) &&
    profile.targetDomain === null &&
    profile.siteName === null &&
    // A bare query ("iphone 15") is a follow-up too: the open site searches it before Google does.
    (profile.navigationPolicy === 'REUSE_CURRENT_CONTEXT' ||
      profile.navigationPolicy === 'SEARCH_AS_LAST_RESORT') &&
    SEARCH_ACTIONS.has(profile.action ?? '')
  );
}

function hereTarget(context: TabContext): Target {
  const site = siteForDomain(context.host);
  const url = new URL(context.url);
  return Target.parse({
    domain: context.host,
    // Never carry the page's query string/fragment into records: it can hold personal data.
    url: `${url.origin}${url.pathname}`,
    adapterId: site?.id ?? null,
    reason: 'current-tab',
  });
}

export function siteTarget(domain: string, reason: Target['reason']): Target {
  const site = siteForDomain(domain);
  return Target.parse({
    domain: site?.domain ?? domain,
    url: site ? site.homeUrl : `https://${domain}/`,
    adapterId: site?.id ?? null,
    reason,
  });
}

/** The context tab is already on `domain` (or a subdomain of it). */
function onDomain(context: TabContext | null, domain: string): boolean {
  if (!context) return false;
  const site = siteForDomain(domain);
  return hostMatchesDomain(context.host, site?.domain ?? domain);
}

/** The context tab's site is named after `name` ("acme" ↔ www.acme.com/in/). */
function onNamedSite(context: TabContext | null, name: string): boolean {
  const labels = brandLabels(name);
  if (!context || !labels) return false;
  const label = domainLabel(registrableDomain(context.host));
  return label === labels.joined || label === labels.hyphen;
}

export function decideNavigation(
  profile: IntentProfile,
  context: TabContext | null,
  fit: ContextFit | null,
): NavigationDecisionResult {
  const unsupported = profile.entities.find((e) => e.type === UNSUPPORTED_ENTITY)?.value;
  if (unsupported) {
    return {
      ok: false,
      code: 'UNSUPPORTED_COMMAND',
      message: `Techie Mind can't "${unsupported}" pages yet — scrolling, going back, sorting, filtering and cart actions come in a later update. Say what to open, search, play or click.`,
    };
  }
  if (profile.intent === 'unknown' || !profile.action) {
    return {
      ok: false,
      code: 'NO_TARGET',
      message: 'Could not understand what to open or do. Name a website or say what to search for.',
    };
  }
  const reuse = (targetSource: TargetSource, reason: string): NavigationDecisionResult => ({
    ok: true,
    targetSource,
    navigationPolicy: 'REUSE_CURRENT_CONTEXT',
    reuse: true,
    inContextTab: true,
    target: hereTarget(context!),
    resolveName: null,
    reason,
  });
  const explicitTab = wantsCurrentTab(profile);

  // 1 + 2 + 3a — a domain or known site was named.
  if (profile.targetDomain) {
    if (explicitTab && !context) return unavailable();
    if (onDomain(context, profile.targetDomain)) {
      return reuse('EXPLICIT_USER_TARGET', `the current tab is already on ${context!.host}`);
    }
    return {
      ok: true,
      targetSource: 'EXPLICIT_USER_TARGET',
      navigationPolicy: 'DIRECT_NAVIGATE',
      reuse: false,
      inContextTab: explicitTab,
      target: siteTarget(profile.targetDomain, 'explicit-site'),
      resolveName: null,
      reason: explicitTab
        ? `navigate this tab to ${profile.targetDomain}`
        : `the user named ${profile.targetDomain}`,
    };
  }

  // 3b — a website name that is not a known site: resolve it (unless we are already there).
  if (profile.siteName) {
    if (explicitTab && !context) return unavailable();
    if (onNamedSite(context, profile.siteName)) {
      return reuse('CURRENT_PAGE', `the current tab is already on ${context!.host}`);
    }
    return {
      ok: true,
      targetSource: 'RESOLVED_WEBSITE',
      navigationPolicy: 'RESOLVE_WEBSITE',
      reuse: false,
      inContextTab: explicitTab,
      target: null,
      resolveName: profile.siteName,
      reason: `find the website for "${profile.siteName}"`,
    };
  }

  // 1 — "in the current tab / here / on this page": never navigate away.
  if (explicitTab) {
    if (!context) return unavailable();
    return reuse('CURRENT_TAB', 'the user asked to work in the current tab');
  }

  // Results already on screen: "play the first one".
  if (RESULT_ACTIONS.has(profile.action)) {
    if (!context) {
      return {
        ok: false,
        code: 'NO_RESULTS_CONTEXT',
        message:
          profile.action === 'play_result' ||
          profile.action === 'open_result' ||
          profile.action === 'pick_item'
            ? 'There is no open web page with results to choose from.'
            : 'There is no open web page to do that on. Open the page first.',
      };
    }
    return reuse('CURRENT_PAGE', `pick from the results on ${context.host}`);
  }

  // 4 — no site named: the open page, when it can do this.
  const media = profile.action === 'search_and_play';
  if (context && fit && fit.canSearch && (!media || fit.hasMedia)) {
    return reuse(
      'CURRENT_PAGE',
      `${context.host} can ${media ? 'search and play media' : 'search'} — continuing there`,
    );
  }
  const why = !context
    ? 'no web page is open'
    : !fit
      ? 'the request is not tied to the open page'
      : !fit.canSearch
        ? `${context.host} has no search`
        : `${context.host} is not a media site`;

  // 5 — intent default: playback goes to the default media site.
  if (media) {
    const site = siteById(DEFAULT_MEDIA_SITE);
    if (!site) return { ok: false, code: 'NO_TARGET', message: 'No media site configured.' };
    return {
      ok: true,
      targetSource: 'RESOLVED_WEBSITE',
      navigationPolicy: 'DIRECT_NAVIGATE',
      reuse: false,
      inContextTab: false,
      target: siteTarget(site.domain, 'resolved-website'),
      resolveName: null,
      reason: `${why}; playback defaults to ${site.name}`,
    };
  }

  // 6 — last resort: a search engine.
  if (profile.query) {
    const engine = siteById(DEFAULT_SEARCH_SITE);
    if (!engine) return { ok: false, code: 'NO_TARGET', message: 'No search fallback configured.' };
    return {
      ok: true,
      targetSource: 'SEARCH_DISCOVERY',
      navigationPolicy: 'SEARCH_AS_LAST_RESORT',
      reuse: false,
      inContextTab: false,
      target: siteTarget(engine.domain, 'generic-search'),
      resolveName: null,
      reason: `${why}; searching the web as a last resort`,
    };
  }
  return { ok: false, code: 'NO_TARGET', message: 'The request names no website or query.' };

  function unavailable(): NavigationDecisionResult {
    return {
      ok: false,
      code: 'CURRENT_TAB_UNAVAILABLE',
      message:
        'The current tab is not a web page the agent can work in (browser pages and the new-tab page are off limits). Open a website first.',
    };
  }
}

/** Search-engine discovery for a website name that could not be resolved safely. */
export function discoveryTarget(): Target | null {
  const engine = siteById(DEFAULT_SEARCH_SITE);
  return engine ? siteTarget(engine.domain, 'search-discovery') : null;
}
