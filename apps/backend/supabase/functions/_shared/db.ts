/**
 * Minimal Supabase access over HTTP (PostgREST + Auth), with no third-party imports.
 * SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase into
 * every Edge Function; they never reach the browser extension (spec §40).
 */

interface Env {
  get(name: string): string | undefined;
}

export function env(name: string): string {
  const value = (globalThis as unknown as { Deno: { env: Env } }).Deno.env.get(name);
  if (!value) throw new Error(`missing server setting ${name}`);
  return value;
}

export function optionalEnv(name: string): string | null {
  return (globalThis as unknown as { Deno: { env: Env } }).Deno.env.get(name) ?? null;
}

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    ...extra,
  };
}

/** PostgREST request as the service role (bypasses RLS — callers MUST scope by user). */
export async function rest<T>(
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: serviceHeaders(init.prefer ? { prefer: init.prefer } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`database ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return rest<T>(`rpc/${name}`, { method: 'POST', body: args });
}

export interface AuthUser {
  id: string;
  email: string;
  confirmed: boolean;
}

/** The signed-in user behind a bearer token, verified by Supabase Auth (null = not signed in). */
export async function userFromRequest(req: Request): Promise<AuthUser | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return null;
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as {
    id?: string;
    email?: string;
    email_confirmed_at?: string | null;
  };
  if (!user.id || !user.email) return null;
  return { id: user.id, email: user.email, confirmed: Boolean(user.email_confirmed_at) };
}

/** Constant-time string comparison (shared secrets). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
