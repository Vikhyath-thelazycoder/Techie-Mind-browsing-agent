/**
 * Monitor worker (spec §38, §41): called by pg_cron every 5 minutes with a shared secret.
 *
 * schedule → claim due monitors (locked) → safe fetch → read page → evaluate → transition →
 * complete_check (history + state + outbox in one transaction) → send outbox e-mails.
 *
 * Deploy with `--no-verify-jwt` (it authenticates with MONITOR_WORKER_SECRET instead).
 */
import { emailFor, evaluate, readPage, type MonitorRow } from '../_shared/core.ts';
import { env, json, optionalEnv, rpc, sameSecret } from '../_shared/db.ts';
import { safeFetch } from '../_shared/safe-fetch.ts';

/** Stop claiming new work after this long, so a run finishes well inside the cron timeout. */
const RUN_BUDGET_MS = 40_000;
const CLAIM_BATCH = 10;
const LEASE_SECONDS = 120;
/** Pause between two requests to the same site (politeness). */
const SAME_HOST_GAP_MS = 1_500;

interface OutboxRow {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  dedupe_key: string;
  attempts: number;
}

async function checkOne(monitor: MonitorRow): Promise<'notified' | 'checked' | 'failed'> {
  try {
    const page = await safeFetch(monitor.url);
    const reading = await readPage(page.html, page.status);
    const result = evaluate(monitor, reading);
    const mail = result.notify ? emailFor(monitor, result) : null;
    await rpc('complete_check', {
      p_monitor: monitor.id,
      p_outcome: result.outcome,
      p_value: result.value,
      p_hash: result.hash,
      p_available: result.available,
      p_condition_met: result.conditionMet,
      p_notify: result.notify,
      p_subject: mail?.subject ?? null,
      p_body: mail?.body ?? null,
      p_http_status: page.status,
      p_error: result.error,
    });
    return result.notify ? 'notified' : result.outcome === 'ok' ? 'checked' : 'failed';
  } catch (error) {
    await rpc('complete_check', {
      p_monitor: monitor.id,
      p_outcome: 'error',
      p_value: null,
      p_hash: null,
      p_available: null,
      p_condition_met: null,
      p_notify: false,
      p_subject: null,
      p_body: null,
      p_http_status: null,
      p_error: error instanceof Error ? error.message.slice(0, 300) : 'check failed',
    }).catch(() => undefined);
    return 'failed';
  }
}

/** Send one outbox e-mail through Resend. The dedupe key is the idempotency key. */
async function send(row: OutboxRow): Promise<void> {
  const apiKey = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('MONITOR_FROM_EMAIL');
  if (!apiKey || !from)
    throw new Error('e-mail is not configured (RESEND_API_KEY, MONITOR_FROM_EMAIL)');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': row.dedupe_key.slice(0, 256),
    },
    body: JSON.stringify({ from, to: [row.recipient], subject: row.subject, text: row.body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`e-mail provider ${res.status}: ${(await res.text()).slice(0, 150)}`);
}

async function run(): Promise<Record<string, number>> {
  const started = Date.now();
  const stats = { claimed: 0, checked: 0, notified: 0, failed: 0, sent: 0, sendFailed: 0 };
  const lastHit = new Map<string, number>();

  while (Date.now() - started < RUN_BUDGET_MS) {
    const batch = await rpc<MonitorRow[]>('claim_due_monitors', {
      p_limit: CLAIM_BATCH,
      p_lease_seconds: LEASE_SECONDS,
    });
    if (!batch?.length) break;
    stats.claimed += batch.length;
    for (const monitor of batch) {
      const host = new URL(monitor.url).hostname;
      const wait = (lastHit.get(host) ?? 0) + SAME_HOST_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastHit.set(host, Date.now());
      const outcome = await checkOne(monitor);
      stats[outcome === 'notified' ? 'notified' : outcome === 'checked' ? 'checked' : 'failed'] +=
        1;
    }
  }

  const outbox = await rpc<OutboxRow[]>('claim_outbox', { p_limit: 20, p_lease_seconds: 60 });
  for (const row of outbox ?? []) {
    try {
      await send(row);
      await rpc('complete_outbox', { p_id: row.id, p_ok: true, p_error: null });
      stats.sent += 1;
    } catch (error) {
      await rpc('complete_outbox', {
        p_id: row.id,
        p_ok: false,
        p_error: error instanceof Error ? error.message : 'send failed',
      });
      stats.sendFailed += 1;
    }
  }
  return stats;
}

(
  globalThis as unknown as { Deno: { serve(h: (req: Request) => Promise<Response>): void } }
).Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!token || !sameSecret(token, env('MONITOR_WORKER_SECRET'))) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    return json({ ok: true, ...(await run()) });
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : 'worker failed' },
      500,
    );
  }
});
