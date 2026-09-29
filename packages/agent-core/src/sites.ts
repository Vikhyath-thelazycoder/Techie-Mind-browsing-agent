/**
 * Known-site routing metadata (spec §9). This is ROUTING data only — domain, home page and the
 * names people use for a site. There are deliberately no selectors or action scripts here: the page
 * itself is always understood through generic DOM/A11y perception and semantic grounding.
 */
export type SiteCategory =
  'video' | 'shopping' | 'search' | 'code' | 'reference' | 'social' | 'mail' | 'music';

export interface SiteEntry {
  id: string;
  name: string;
  /** Registrable domain used for routing and navigation verification. */
  domain: string;
  homeUrl: string;
  /** Lowercase names users say or type, longest first is not required. */
  aliases: readonly string[];
  category: SiteCategory;
}

export const KNOWN_SITES: readonly SiteEntry[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    domain: 'youtube.com',
    homeUrl: 'https://www.youtube.com/',
    aliases: ['youtube', 'you tube', 'yt'],
    category: 'video',
  },
  {
    id: 'flipkart',
    name: 'Flipkart',
    domain: 'flipkart.com',
    homeUrl: 'https://www.flipkart.com/',
    aliases: ['flipkart', 'flip kart'],
    category: 'shopping',
  },
  {
    id: 'amazon',
    name: 'Amazon',
    domain: 'amazon.in',
    homeUrl: 'https://www.amazon.in/',
    aliases: ['amazon', 'amazon india'],
    category: 'shopping',
  },
  {
    id: 'google',
    name: 'Google',
    domain: 'google.com',
    homeUrl: 'https://www.google.com/',
    aliases: ['google'],
    category: 'search',
  },
  {
    id: 'github',
    name: 'GitHub',
    domain: 'github.com',
    homeUrl: 'https://github.com/',
    aliases: ['github', 'git hub'],
    category: 'code',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    domain: 'wikipedia.org',
    homeUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    aliases: ['wikipedia', 'wiki'],
    category: 'reference',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    domain: 'mail.google.com',
    homeUrl: 'https://mail.google.com/',
    aliases: ['gmail', 'g mail'],
    category: 'mail',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    domain: 'linkedin.com',
    homeUrl: 'https://www.linkedin.com/',
    aliases: ['linkedin', 'linked in'],
    category: 'social',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    domain: 'instagram.com',
    homeUrl: 'https://www.instagram.com/',
    aliases: ['instagram', 'insta'],
    category: 'social',
  },
  {
    id: 'netflix',
    name: 'Netflix',
    domain: 'netflix.com',
    homeUrl: 'https://www.netflix.com/',
    aliases: ['netflix'],
    category: 'video',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    domain: 'duckduckgo.com',
    homeUrl: 'https://duckduckgo.com/',
    aliases: ['duckduckgo', 'duck duck go', 'ddg'],
    category: 'search',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    domain: 'spotify.com',
    homeUrl: 'https://open.spotify.com/',
    aliases: ['spotify'],
    category: 'music',
  },
];

/** Default destination for playback requests that name no site. */
export const DEFAULT_MEDIA_SITE = 'youtube';
/** Fallback for searches that name no site (spec §47: Google is a fallback, not the default). */
export const DEFAULT_SEARCH_SITE = 'google';
/** Second web search for research when the first one asks automated browsers for a human check. */
export const FALLBACK_SEARCH_SITE = 'duckduckgo';

export function siteById(id: string): SiteEntry | undefined {
  return KNOWN_SITES.find((s) => s.id === id);
}

/** Match a hostname or bare domain to a known site (subdomains included). */
export function siteForDomain(domain: string): SiteEntry | undefined {
  const d = domain.replace(/^www\./, '');
  return KNOWN_SITES.find((s) => d === s.domain || d.endsWith(`.${s.domain}`));
}

/** True when `hostname` is `domain` or one of its subdomains. */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}
