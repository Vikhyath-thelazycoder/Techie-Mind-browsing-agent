import { isPublicIp, urlProblem } from './core.ts';

/**
 * SSRF-safe page fetch for the monitor worker (spec §42):
 * - https on port 443 only; no credentials in URLs; no internal host names (static rules in core);
 * - every host is resolved first and EVERY address must be public (no loopback, private, link-local
 *   / cloud metadata, CGNAT, multicast, NAT64 …) — checked again on each redirect hop;
 * - redirects are followed manually (max 3), bodies are capped, requests time out.
 *
 * Residual risk (documented in docs/MONITORING_BACKEND.md): the runtime's fetch resolves the name
 * again, so a DNS-rebinding attacker could race the check. The worker never sends credentials or
 * cookies and only reads public HTML, which limits what such a race could reach.
 */

export interface FetchedPage {
  status: number;
  url: string;
  html: string;
}

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (compatible; TechieMindMonitor/1.0; checks a page its user asked to watch)';

async function resolveAddresses(host: string): Promise<string[]> {
  const deno = (
    globalThis as { Deno?: { resolveDns?: (h: string, t: 'A' | 'AAAA') => Promise<string[]> } }
  ).Deno;
  if (deno?.resolveDns) {
    const settled = await Promise.allSettled([
      deno.resolveDns(host, 'A'),
      deno.resolveDns(host, 'AAAA'),
    ]);
    const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (found.length > 0) return found;
  }
  // DNS over HTTPS when the runtime has no resolver API.
  const out: string[] = [];
  for (const type of ['A', 'AAAA'] as const) {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) continue;
    const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    for (const a of body.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
  }
  return out;
}

/** Throws when the URL may not be fetched. */
export async function assertFetchable(raw: string): Promise<URL> {
  const problem = urlProblem(raw);
  if (problem) throw new Error(problem);
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return url; // IP literal, checked by urlProblem
  const addresses = await resolveAddresses(host);
  if (addresses.length === 0) throw new Error('the site name does not resolve');
  if (!addresses.every(isPublicIp)) throw new Error('the site resolves to a private address');
  return url;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BYTES - kept;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    kept += Math.min(value.byteLength, room);
    if (kept >= MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(kept);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

export async function safeFetch(raw: string): Promise<FetchedPage> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertFetchable(current);
    const res = await fetch(url.href, {
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error(`redirect without a location (HTTP ${res.status})`);
      current = new URL(location, url).href;
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
      await res.body?.cancel();
      throw new Error(`not a web page (${type.split(';')[0]})`);
    }
    return { status: res.status, url: url.href, html: await readCapped(res) };
  }
  throw new Error('too many redirects');
}
