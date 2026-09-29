/**
 * Authenticated monitor API (spec §38, §42). The extension calls it with the signed-in user's
 * access token. Every query is scoped to that user (no IDOR); the notification address is the
 * account's verified e-mail — never taken from the request (no e-mail injection); URLs pass the
 * SSRF rules before they are stored.
 *
 *   GET                                   → the user's monitors (+ latest checks)
 *   POST { action: 'create', url, label, kind, threshold?, currency?, intervalMinutes? }
 *   POST { action: 'pause' | 'resume' | 'cancel' | 'delete' | 'check-now', id }
 */
import { isEmail, urlProblem, type MonitorKind } from '../_shared/core.ts';
import { json, rest, userFromRequest } from '../_shared/db.ts';
import { assertFetchable } from '../_shared/safe-fetch.ts';

const MAX_MONITORS_PER_USER = 50;
const KINDS = new Set<MonitorKind>(['price-below', 'content-changed', 'available']);
const CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_COLUMNS =
  'id,url,label,kind,threshold,currency,interval_minutes,status,next_run_at,last_checked_at,last_value,last_available,condition_met,consecutive_failures,last_error,created_at';

/** Only browser-extension pages call this API (the bearer token is what authorizes it). */
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin) ? origin : 'null';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value
        .replace(/\p{Cc}+/gu, ' ')
        .trim()
        .slice(0, max)
    : '';
}

async function create(userId: string, email: string, body: Record<string, unknown>) {
  const url = text(body['url'], 2048);
  const problem = urlProblem(url);
  if (problem) return json({ error: problem }, 400);
  try {
    await assertFetchable(url);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'address not allowed' }, 400);
  }
  const kind = body['kind'] as MonitorKind;
  if (!KINDS.has(kind))
    return json({ error: 'kind must be price-below, content-changed or available' }, 400);
  const threshold = kind === 'price-below' ? Number(body['threshold']) : null;
  if (
    kind === 'price-below' &&
    !(Number.isFinite(threshold) && threshold! > 0 && threshold! < 1e12)
  ) {
    return json({ error: 'a price monitor needs a positive target price' }, 400);
  }
  const currency = kind === 'price-below' ? text(body['currency'], 3).toUpperCase() || 'INR' : null;
  if (currency && !CURRENCIES.has(currency)) return json({ error: 'unsupported currency' }, 400);
  const interval = Math.round(Number(body['intervalMinutes'] ?? 60));
  if (!(interval >= 15 && interval <= 10080)) {
    return json({ error: 'the interval must be between 15 minutes and 7 days' }, 400);
  }
  if (!isEmail(email)) return json({ error: 'your account has no usable e-mail address' }, 400);

  const existing = await rest<Array<{ id: string }>>(
    `monitors?select=id&user_id=eq.${userId}&status=in.(active,paused,error)`,
  );
  if (existing.length >= MAX_MONITORS_PER_USER) {
    return json({ error: `you already have ${MAX_MONITORS_PER_USER} monitors` }, 400);
  }
  const rows = await rest<unknown[]>(`monitors?select=${LIST_COLUMNS}`, {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: userId,
      url,
      label: text(body['label'], 200),
      kind,
      threshold,
      currency,
      interval_minutes: interval,
      notify_email: email,
      // First check soon, so the user sees it working.
      next_run_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  return json({ monitor: rows[0] ?? null }, 201);
}

async function control(userId: string, action: string, id: string) {
  if (!UUID.test(id)) return json({ error: 'invalid monitor id' }, 400);
  // Scoped by user_id: another user's id matches nothing (no IDOR).
  const scope = `monitors?id=eq.${id}&user_id=eq.${userId}`;
  if (action === 'delete') {
    const gone = await rest<unknown[]>(`${scope}&select=id`, {
      method: 'DELETE',
      prefer: 'return=representation',
    });
    return gone.length ? json({ ok: true }) : json({ error: 'monitor not found' }, 404);
  }
  const patch: Record<string, unknown> =
    action === 'pause'
      ? { status: 'paused' }
      : action === 'resume'
        ? { status: 'active', consecutive_failures: 0, next_run_at: new Date().toISOString() }
        : action === 'cancel'
          ? { status: 'cancelled' }
          : action === 'check-now'
            ? { next_run_at: new Date().toISOString() }
            : {};
  if (Object.keys(patch).length === 0) return json({ error: 'unknown action' }, 400);
  const rows = await rest<unknown[]>(
    `${scope}${action === 'check-now' ? '&status=eq.active' : ''}&select=${LIST_COLUMNS}`,
    {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { ...patch, updated_at: new Date().toISOString() },
    },
  );
  return rows.length
    ? json({ monitor: rows[0] })
    : json({ error: 'monitor not found or not active' }, 404);
}

(
  globalThis as unknown as { Deno: { serve(h: (req: Request) => Promise<Response>): void } }
).Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const user = await userFromRequest(req);
    if (!user) return json({ error: 'sign in first' }, 401, headers);
    if (!user.confirmed) return json({ error: 'confirm your e-mail address first' }, 403, headers);

    if (req.method === 'GET') {
      const monitors = await rest<unknown[]>(
        `monitors?select=${LIST_COLUMNS}&user_id=eq.${user.id}&status=neq.cancelled&order=created_at.desc&limit=100`,
      );
      return json({ monitors, email: user.email }, 200, headers);
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, headers);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return json({ error: 'invalid body' }, 400, headers);
    const action = text(body['action'], 20);
    const response =
      action === 'create'
        ? await create(user.id, user.email, body)
        : await control(user.id, action, text(body['id'], 64));
    for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
    return response;
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message.slice(0, 200) : 'failed' },
      500,
      headers,
    );
  }
});
