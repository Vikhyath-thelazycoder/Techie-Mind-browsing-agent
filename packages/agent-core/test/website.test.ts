import type { WebsiteProbe } from '@techie-mind/contracts';
import { describe, expect, it } from 'vitest';
import {
  brandLabels,
  extractIdentity,
  registrableDomain,
  resolutionAlternatives,
  resolveWebsite,
  websiteCandidates,
} from '../src/website.js';

/**
 * Website resolution from probe evidence. The probe shapes below mirror what real candidate domains
 * returned when this was built (redirect targets, bot walls, parked pages, look-alike sites) but use
 * made-up names, so the resolver can never have learned a brand.
 */

const page = (title: string, extra = '') =>
  `<!doctype html><html><head><title>${title}</title>${extra}</head><body><p>Welcome</p></body></html>`;

function probes(map: Record<string, Partial<WebsiteProbe> | 'dns'>): WebsiteProbe[] {
  return Object.entries(map).map(([domain, p]) => {
    const url = `https://${domain}/`;
    if (p === 'dns')
      return { url, status: null, finalUrl: null, body: '', error: 'ENOTFOUND', ms: 5 };
    return { url, status: 200, finalUrl: url, body: '', error: null, ms: 5, ...p };
  });
}

function resolve(name: string, map: Record<string, Partial<WebsiteProbe> | 'dns'>) {
  const candidates = websiteCandidates(name, 'IN');
  const list = probes(Object.fromEntries(candidates.map((d) => [d, map[d] ?? 'dns'])));
  return resolveWebsite(name, candidates, list);
}

describe('candidate generation', () => {
  it('derives domain labels from names, including multi-word and apostrophes', () => {
    expect(brandLabels('Lumora')).toMatchObject({ joined: 'lumora', hyphen: null });
    expect(brandLabels("Kavi's Kitchen")).toMatchObject({
      joined: 'kaviskitchen',
      hyphen: 'kavis-kitchen',
    });
    expect(brandLabels('Blue & Gold')).toMatchObject({ joined: 'blueandgold' });
    // A name that cannot form a hostname is not guessed at.
    expect(brandLabels('ಕನ್ನಡ')).toBeNull();
    expect(brandLabels('')).toBeNull();
  });

  it('tries .com, Indian and common TLDs, bounded, most likely first', () => {
    const c = websiteCandidates('Lumora', 'IN');
    expect(c.slice(0, 3)).toEqual(['lumora.com', 'lumora.in', 'lumora.co.in']);
    expect(c.length).toBeLessThanOrEqual(10);
    expect(websiteCandidates('Kavi Kitchen', 'IN')).toContain('kavi-kitchen.com');
    expect(websiteCandidates('Lumora', 'GB')).toContain('lumora.co.uk');
  });

  it('groups hosts by registrable domain, including two-level public suffixes', () => {
    expect(registrableDomain('www.shop.lumora.co.in')).toBe('lumora.co.in');
    expect(registrableDomain('www.lumora.com')).toBe('lumora.com');
    expect(registrableDomain('m.lumora.co.uk')).toBe('lumora.co.uk');
  });

  it('reads title, site name and meta refresh from raw HTML', () => {
    const id = extractIdentity(
      page(
        'Lumora &amp; Co &#8211; Home',
        '<meta property="og:site_name" content="LUMORA"><meta http-equiv="refresh" content="0; url=/in/">',
      ),
      'https://www.lumora.com/',
    );
    expect(id.title).toBe('Lumora & Co – Home');
    expect(id.siteName).toBe('LUMORA');
    expect(id.refreshUrl).toBe('https://www.lumora.com/in/');
  });
});

describe('resolveWebsite — evidence scoring', () => {
  it('picks the site that names itself after the brand', () => {
    const r = resolve('Lumora', {
      'lumora.com': { finalUrl: 'https://www.lumora.com/', body: page('Lumora — Official Store') },
    });
    expect(r.chosen).toEqual({ domain: 'lumora.com', url: 'https://www.lumora.com/' });
    expect(r.ambiguous).toBe(false);
    expect(r.candidates.find((c) => c.domain === 'lumora.com')?.verdict).toBe('verified');
    expect(r.candidates.find((c) => c.domain === 'lumora.in')?.verdict).toBe('unreachable');
  });

  it('prefers the site several candidates converge on over a look-alike that names itself (title-less JS page)', () => {
    // Real pattern: brand.in/.net/.co all redirect to brand.com, whose raw HTML has no title
    // (JS challenge), while brand.org is an unrelated place page titled with the same word.
    const r = resolve('Veltra', {
      'veltra.com': { finalUrl: 'https://www.veltra.com/', body: page('&nbsp;') },
      'veltra.in': { finalUrl: 'https://www.veltra.com/in/', body: page('&nbsp;') },
      'veltra.net': { finalUrl: 'https://www.veltra.com/', body: page('&nbsp;') },
      'veltra.co': { finalUrl: 'https://www.veltra.com/co/', body: page('&nbsp;') },
      'veltra.org': { body: page('Veltra, Sivas, Türkiye') },
    });
    expect(r.chosen?.domain).toBe('veltra.com');
    expect(r.ambiguous).toBe(false);
    expect(r.candidates.find((c) => c.domain === 'veltra.in')?.finalDomain).toBe('veltra.com');
  });

  it('follows a "we moved" notice to the endorsed domain', () => {
    const r = resolve('Quillo', {
      'quillo.com': {
        finalUrl: 'https://www.quillo.com/',
        body: page('Buy fashion online in India - QUILLO'),
      },
      'quillo.co.in': {
        finalUrl: 'https://www.quillo.co.in/',
        body: page('QUILLO is now quillo.com', '<meta property="og:site_name" content="QUILLO">'),
      },
      'quillo.org': { body: page('') },
    });
    expect(r.chosen?.domain).toBe('quillo.com');
    expect(r.ambiguous).toBe(false);
  });

  it('rejects parked / for-sale / default hosting pages', () => {
    const r = resolve('Pravan', {
      'pravan.com': {
        finalUrl: 'https://www.pravan.com/',
        body: page(
          'Online Shopping for Fashion - Pravan',
          '<meta property="og:site_name" content="Pravan">',
        ),
      },
      'pravan.in': { body: page('pravan.in&nbsp;-&nbsp;This website is for sale!') },
      'pravan.net': { body: page('Business-Class Web Hosting by (mt) Media Temple') },
    });
    expect(r.chosen?.domain).toBe('pravan.com');
    expect(r.candidates.find((c) => c.domain === 'pravan.in')?.verdict).toBe('rejected');
    expect(r.candidates.find((c) => c.domain === 'pravan.net')?.verdict).toBe('rejected');
  });

  it('accepts a bot-walled site that every candidate redirects to (regional domain)', () => {
    // Real pattern: brand.com/.co.in/.org/.co → 403 "Access Denied" on www.brand.in.
    const walled = { status: 403, finalUrl: 'https://www.torvo.in/', body: page('Access Denied') };
    const r = resolve('Torvo', {
      'torvo.com': walled,
      'torvo.co.in': walled,
      'torvo.org': walled,
      'torvo.co': walled,
    });
    expect(r.chosen).toEqual({ domain: 'torvo.in', url: 'https://www.torvo.in/' });
    expect(r.candidates.every((c) => c.verdict !== 'verified')).toBe(true);
  });

  it('follows meta-refresh redirects and rejects redirects to unrelated domains', () => {
    const r = resolve('Sparrowly', {
      'sparrowly.com': { finalUrl: 'https://www.sparrowly.com/', body: page('Sparrowly') },
      'sparrowly.org': {
        body: page(
          'Redirecting...',
          '<meta http-equiv="refresh" content="0;url=https://www.sparrowly.com/">',
        ),
      },
      'sparrowly.net': {
        status: 403,
        finalUrl: 'https://domains.brokerage.example/lpd/name/sparrowly.net',
        body: page('Just a moment...'),
      },
    });
    expect(r.chosen?.domain).toBe('sparrowly.com');
    expect(r.candidates.find((c) => c.domain === 'sparrowly.org')?.finalDomain).toBe(
      'sparrowly.com',
    );
    expect(r.candidates.find((c) => c.domain === 'sparrowly.net')).toMatchObject({
      verdict: 'rejected',
    });
  });

  it('reports ambiguity instead of guessing between two verified, equally supported sites', () => {
    const r = resolve('Orbis', {
      'orbis.in': { body: page('Orbis Eyewear India') },
      'orbis.org': { body: page('Orbis — Global eye-care charity') },
    });
    expect(r.ambiguous).toBe(true);
    expect(resolutionAlternatives(r).sort()).toEqual(['orbis.in', 'orbis.org']);
  });

  it('returns no choice when nothing is reachable or everything is a placeholder', () => {
    expect(resolve('Zzqxv', {}).chosen).toBeNull();
    expect(
      resolve('Zzqxv', { 'zzqxv.com': { body: page('zzqxv.com is for sale — make an offer') } })
        .chosen,
    ).toBeNull();
  });

  it('never accepts a 404 home page', () => {
    const r = resolve('Nolo', { 'nolo.com': { status: 404, body: page('Nolo') } });
    expect(r.chosen).toBeNull();
  });
});
