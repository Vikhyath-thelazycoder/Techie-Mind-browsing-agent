import { Skill, type SkillId } from '@techie-mind/contracts';

/**
 * The 12 first-class skills (spec §30, plan §33). Each has a manifest (the Skill contract: inputs,
 * risk, permissions, verification, failure handling) and intent phrases. Execution runs on the same
 * generic pipeline as every task (observe → ground → firewall → execute → verify); skills add
 * orchestration, never site scripts.
 */

const m = (s: Skill): Skill => Skill.parse(s);
const input = (
  name: string,
  type: 'string' | 'number' | 'boolean' | 'url' | 'enum',
  required: boolean,
  description: string,
  options: string[] | null = null,
) => ({ name, type, required, description, options });

export const SKILLS: Record<SkillId, Skill> = {
  'summarize-page': m({
    id: 'summarize-page',
    name: 'Summarize page',
    description:
      'Summarize the open page from locally extracted, redacted text (local model, or extractive without one).',
    version: '1.0.0',
    inputs: [],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['scripting'],
    verification:
      'A non-empty summary built from the page text; the source (model / extractive) is shown.',
    failureHandling: 'No readable text → tells the user; model unavailable → extractive summary.',
  }),
  'deep-research': m({
    id: 'deep-research',
    name: 'Deep research',
    description:
      'Search, open several sources in turn, extract evidence and synthesize it with citations.',
    version: '1.0.0',
    inputs: [
      input('topic', 'string', true, 'What to research'),
      input('site', 'string', false, 'Site to search (default: web search)'),
    ],
    riskLevel: 'MEDIUM',
    requiresConfirmation: false,
    permissions: ['scripting', 'tabs'],
    verification:
      'At least two sources were opened and read; every bullet cites the source it came from.',
    failureHandling:
      'Unreadable sources are skipped and listed; fewer than two sources → reported, not padded.',
  }),
  'extract-data': m({
    id: 'extract-data',
    name: 'Extract data',
    description:
      'Turn the open page into structured items (title, price, rating, link) or table rows; export CSV/JSON on request.',
    version: '1.0.0',
    inputs: [input('format', 'enum', false, 'Export format', ['csv', 'json'])],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['scripting', 'downloads'],
    verification:
      'Items or rows were read from the page; an export file was handed to the browser download.',
    failureHandling: 'Nothing structured on the page → says so; never invents values.',
  }),
  'compare-prices': m({
    id: 'compare-prices',
    name: 'Compare prices',
    description:
      'Search the same product on two or more named stores, read prices, normalize and compare.',
    version: '1.0.0',
    inputs: [
      input('product', 'string', true, 'Product to compare'),
      input('sites', 'string', true, 'Two or more stores'),
    ],
    riskLevel: 'MEDIUM',
    requiresConfirmation: false,
    permissions: ['scripting', 'tabs'],
    verification:
      'Each store was searched; the matching item and price per store come from that store’s page.',
    failureHandling:
      'A store without a matching priced item is listed as “no price found”, never estimated.',
  }),
  'fill-form': m({
    id: 'fill-form',
    name: 'Fill form',
    description:
      'Fill the open form from the encrypted local profile through vault tokens; never submits.',
    version: '1.0.0',
    inputs: [],
    riskLevel: 'MEDIUM',
    requiresConfirmation: false,
    permissions: ['scripting', 'storage'],
    verification:
      'Each filled field holds the saved value afterwards; skipped fields are listed with the reason.',
    failureHandling:
      'No profile → points to Settings → Profile; passwords, OTPs and cards are never filled.',
  }),
  'find-alternatives': m({
    id: 'find-alternatives',
    name: 'Find alternatives',
    description:
      'Search for an item, exclude the item itself, apply budget constraints and present the best options.',
    version: '1.0.0',
    inputs: [
      input('item', 'string', true, 'What to replace'),
      input('budget', 'number', false, 'Maximum price'),
    ],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['scripting'],
    verification:
      'Alternatives come from the searched page, exclude the original item and satisfy the budget.',
    failureHandling: 'No alternative within the constraints → says so.',
  }),
  'manage-bookmarks': m({
    id: 'manage-bookmarks',
    name: 'Manage bookmarks',
    description: 'Bookmark the open page, search or list bookmarks, remove one exact match.',
    version: '1.0.0',
    inputs: [
      input('operation', 'enum', true, 'What to do', ['add', 'remove', 'search', 'list']),
      input('query', 'string', false, 'Search text'),
    ],
    riskLevel: 'MEDIUM',
    requiresConfirmation: false,
    permissions: ['bookmarks'],
    verification: 'The bookmark exists (add) / is gone (remove) when read back from the browser.',
    failureHandling:
      'Several matches for a removal → none removed, the matches are listed for the user.',
  }),
  'monitor-page': m({
    id: 'monitor-page',
    name: 'Monitor page',
    description:
      'Create a monitor for the open page (price below a threshold, or any change) with its current baseline.',
    version: '1.0.0',
    inputs: [input('threshold', 'number', false, 'Notify when the price falls below this')],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['storage'],
    verification:
      'The monitor definition is stored and listed; the baseline price is read from the page.',
    failureHandling:
      'Non-https pages are refused; background checking needs the monitoring backend (Batch C).',
  }),
  'organize-tabs': m({
    id: 'organize-tabs',
    name: 'Organize tabs',
    description:
      'List tabs, group them by site, find duplicates; close duplicates only when asked.',
    version: '1.0.0',
    inputs: [
      input('operation', 'enum', false, 'What to do', ['group', 'duplicates', 'close-duplicates']),
    ],
    riskLevel: 'MEDIUM',
    requiresConfirmation: false,
    permissions: ['tabs'],
    verification: 'Groups and closed tabs are read back from the browser.',
    failureHandling:
      'Pinned, active and single tabs are never closed; grouping unsupported → a report instead.',
  }),
  'read-later': m({
    id: 'read-later',
    name: 'Read later',
    description: 'Save the open page to the local read-later list, list it, or remove an entry.',
    version: '1.0.0',
    inputs: [input('operation', 'enum', false, 'What to do', ['add', 'list', 'remove'])],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['storage'],
    verification: 'The entry is present in the list read back from storage.',
    failureHandling: 'Stores URL (no query string) and title only — never page content.',
  }),
  'save-page': m({
    id: 'save-page',
    name: 'Save page',
    description:
      'Save the open page’s readable content as a Markdown file through the browser download.',
    version: '1.0.0',
    inputs: [],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['scripting', 'downloads'],
    verification: 'The browser accepted the download of a non-empty file.',
    failureHandling:
      'No readable text → says so; secrets (keys, tokens, passwords) are redacted in the file.',
  }),
  'screenshot-walkthrough': m({
    id: 'screenshot-walkthrough',
    name: 'Screenshot walkthrough',
    description:
      'A redacted screenshot of the open page with numbered regions and a step-by-step explanation.',
    version: '1.0.0',
    inputs: [],
    riskLevel: 'LOW',
    requiresConfirmation: false,
    permissions: ['scripting', 'downloads'],
    verification:
      'The image was captured with sensitive regions painted over and saved; steps match the marked regions.',
    failureHandling: 'Tab not visible → cannot capture, says so.',
  }),
};

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** Entity carrying the skill id, and one carrying its argument text. */
export const SKILL_ENTITY = 'skill';
export const SKILL_ARG_ENTITY = 'skill_arg';

/**
 * Natural wording per skill. Matched on the whole request (after conversational openers).
 * summarize-page and fill-form are Phase 5 page commands and keep their own phrases there.
 */
const PHRASES: Array<{ id: SkillId; re: RegExp; arg?: (m: RegExpExecArray) => string }> = [
  {
    id: 'compare-prices',
    re: /^compare\s+(?:the\s+)?(?:prices?\s+(?:of|for)\s+)?(.+?)(?:\s+prices?)?\s+(?:on|across|between|at|in)\s+(.+)$/u,
    arg: (m) => `${m[1]}|${m[2]}`,
  },
  {
    id: 'find-alternatives',
    re: /^(?:find|show|suggest|get)\s+(?:me\s+)?(?:some\s+)?(?:alternatives?|options|replacements?|similar\s+(?:items|products))\s+(?:to|for)\s+(.+)$/u,
    arg: (m) => m[1]!,
  },
  {
    id: 'deep-research',
    re: /^(?:do\s+(?:a\s+)?)?(?:deep\s+)?research(?:\s+(?:on|about))?\s+(.+)$/u,
    arg: (m) => m[1]!,
  },
  {
    id: 'extract-data',
    re: /^(?:extract|export|scrape|pull\s+out|get)\s+(?:the\s+|all\s+(?:the\s+)?)?(?:data|table|tables|items|products|list|prices|results)(?:\s+(?:from|on)\s+(?:this|the)\s+page)?(?:\s+(?:as|to|in)\s+(csv|json))?$/u,
    arg: (m) => m[1] ?? '',
  },
  {
    id: 'manage-bookmarks',
    re: /^(?:bookmark\s+(?:(?:this|it)(?:\s+page)?|the\s+page)|add\s+(?:this|the\s+page)\s+to\s+(?:my\s+)?bookmarks|save\s+(?:this|it)\s+as\s+a\s+bookmark)$/u,
    arg: () => 'add|',
  },
  {
    id: 'manage-bookmarks',
    re: /^(?:remove|delete)\s+(?:this|the)\s+bookmark$|^(?:remove|delete)\s+this\s+page\s+from\s+(?:my\s+)?bookmarks$/u,
    arg: () => 'remove|',
  },
  {
    id: 'manage-bookmarks',
    re: /^(?:find|search|show|list)\s+(?:my\s+)?bookmarks?(?:\s+(?:for|about|with)\s+(.+))?$/u,
    arg: (m) => `search|${m[1] ?? ''}`,
  },
  {
    id: 'monitor-page',
    re: /^(?:monitor|watch|track)\s+(?:this|the|it)(?:\s+(?:page|product|item|price))?(?:\s+(?:until|till|and\s+tell\s+me\s+when|and\s+notify\s+me\s+when)\s+(?:the\s+|its\s+)?(?:price\s+)?(?:falls|drops|goes|is)\s+(?:below|under)\s+(.+))?$/u,
    arg: (m) => m[1] ?? '',
  },
  {
    id: 'organize-tabs',
    re: /^close\s+(?:all\s+)?(?:the\s+)?duplicate\s+tabs$/u,
    arg: () => 'close-duplicates',
  },
  {
    id: 'organize-tabs',
    re: /^(?:find|show|list)\s+(?:the\s+)?duplicate\s+tabs$/u,
    arg: () => 'duplicates',
  },
  {
    id: 'organize-tabs',
    re: /^(?:organi[sz]e|group|tidy(?:\s+up)?|clean\s+up|sort)\s+(?:my\s+|all\s+(?:my\s+)?|the\s+)?tabs(?:\s+by\s+site)?$/u,
    arg: () => 'group',
  },
  {
    id: 'read-later',
    re: /^(?:show|list|open)\s+(?:my\s+)?(?:read(?:ing)?[- ]later|reading)\s+list$/u,
    arg: () => 'list',
  },
  {
    id: 'read-later',
    re: /^remove\s+(?:this|it)\s+from\s+(?:my\s+)?(?:read(?:ing)?[- ]later|reading)(?:\s+list)?$/u,
    arg: () => 'remove',
  },
  {
    id: 'read-later',
    re: /^(?:save\s+(?:this|it|the\s+page)\s+(?:for\s+later|to\s+read\s+later)|read\s+(?:this|it)\s+later|add\s+(?:this|it)\s+to\s+(?:my\s+)?(?:read(?:ing)?[- ]later|reading)(?:\s+list)?)$/u,
    arg: () => 'add',
  },
  {
    id: 'save-page',
    re: /^(?:save|download|archive)\s+(?:this|the)\s+page(?:\s+(?:offline|as\s+a\s+file|to\s+(?:my\s+)?(?:computer|disk)))?$/u,
  },
  {
    id: 'screenshot-walkthrough',
    re: /^(?:take\s+a\s+|make\s+a\s+|create\s+a\s+|give\s+me\s+a\s+)?screenshot(?:\s+walkthrough)?(?:\s+of\s+(?:this|the)\s+page)?$|^(?:walk\s+me\s+through|explain)\s+(?:this|the)\s+page(?:\s+with\s+(?:a\s+)?screenshots?)?$/u,
  },
];

export interface SkillMatch {
  id: SkillId;
  arg: string;
}

/** `/compare-prices iphone 15 | amazon, flipkart` or natural wording. */
export function detectSkill(text: string): SkillMatch | null {
  const t = text.trim().replace(/[.!?]+$/u, '');
  const slash = /^\/([a-z-]+)\s*(.*)$/u.exec(t);
  if (slash) {
    const id = SKILL_IDS.find((s) => s === slash[1]);
    return id ? { id, arg: slash[2]!.trim() } : null;
  }
  for (const phrase of PHRASES) {
    const match = phrase.re.exec(t);
    if (match) return { id: phrase.id, arg: (phrase.arg?.(match) ?? '').trim() };
  }
  return null;
}
