# Monitoring backend (Supabase)

Phase 8 (spec §38–43). Price, stock and page-change monitors live in **your own Supabase project**.
Checks keep running when Chrome is closed or your Mac is off. Alerts are e-mailed through Resend.

```
Extension ──(user token)──▶ monitor-api (Edge Function) ──▶ Postgres: monitors (RLS)
pg_cron (every 5 min) ──(worker secret)──▶ monitor-worker (Edge Function)
   claim_due_monitors (lease, SKIP LOCKED) → safe fetch (SSRF rules) → read price / stock / text
   → evaluate → false→true transition → complete_check (history + state + outbox, one transaction)
   → claim_outbox → Resend (idempotency key = dedupe key) → complete_outbox (retry with backoff)
```

Code: `apps/backend/supabase/` — `migrations/…_monitoring.sql`, `functions/monitor-api`,
`functions/monitor-worker`, `functions/_shared` (pure logic, safe fetch, DB access).

## One-time setup (about 15 minutes)

You need: a free Supabase account, a free Resend account, and the Supabase CLI
(`brew install supabase/tap/supabase`).

1. **Create the project.** On supabase.com, create a new project and note its **project ref** (the
   `abcd1234` in `https://abcd1234.supabase.co`) and database password.
2. **Push the database and deploy the functions** (from the repo):

   ```bash
   cd apps/backend
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push
   supabase functions deploy monitor-api
   supabase functions deploy monitor-worker --no-verify-jwt
   ```

3. **E-mail (Resend).** In Resend, create an API key. To send to any address, verify a domain you
   own. Without a domain, `onboarding@resend.dev` can send only to your own Resend sign-up address,
   which is enough for testing.
4. **Server secrets.** These stay in Supabase and never go into the extension or git:

   ```bash
   WORKER_SECRET=$(openssl rand -hex 32)
   supabase secrets set RESEND_API_KEY=re_xxx MONITOR_FROM_EMAIL='Techie Mind <onboarding@resend.dev>' MONITOR_WORKER_SECRET=$WORKER_SECRET
   echo $WORKER_SECRET   # needed once, in step 5
   ```

5. **Scheduler secrets.** In Supabase → SQL Editor, run the following. Use your project ref and the
   same secret as in step 4.

   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/monitor-worker', 'monitor_worker_url');
   select vault.create_secret('<WORKER_SECRET>', 'monitor_worker_secret');
   ```

   The cron job `techie-mind-monitor-worker` (created by the migration) now calls the worker every
   5 minutes. To check it: `select * from cron.job_run_details order by start_time desc limit 5;`
6. **Auth.** Supabase → Authentication → Providers: e-mail is on by default. Keep "Confirm email"
   on, because alerts only go to confirmed addresses. In Authentication → URL Configuration, set
   **Site URL** to `https://<project-ref>.supabase.co` (or any page you own): the confirmation link
   redirects there after confirming. The default `http://localhost:3000` shows a page that does not
   load, although the account _is_ confirmed.
   **Table access:** new Supabase projects no longer grant table access by default. The migration
   `…_monitoring_grants.sql` (applied by `supabase db push`) grants it; without it the monitor list
   fails with "permission denied for table monitors".
7. **Extension.** Techie Mind → Settings → Monitoring:
   - paste the **Project URL** and the **anon public** key (Project Settings → API);
   - click **Save**;
   - **Create account**, confirm the e-mail, then **Sign in**.

   Never paste the `service_role` key into the extension.

## Using it

- On a product page, in the side panel:
  - "monitor this product until the price drops below ₹50,000" creates a price alert;
  - "tell me when this is back in stock" creates a stock alert;
  - "watch this page" creates a page-change alert.
- The result card says whether the monitor went to the backend or is stored in this browser only.
- Settings → Monitoring lists your monitors, with the status, last value, last check and any
  problem. Each one has **Check now**, **Pause**, **Resume**, **Cancel** and **Delete**.
- The first check runs about a minute after creation, then at the monitor's interval (60 minutes by
  default; the minimum is 15).

## Security (spec §42)

| Threat | Protection |
|---|---|
| SSRF, private IPs, localhost, metadata endpoints | https only on port 443, no credentials in URLs, internal host names refused. Every DNS answer must be a public address, checked at creation and again on every fetch and redirect hop (at most 3) |
| Dangerous ports | Only 443 |
| DNS rebinding | Addresses are re-checked on each hop. **Residual risk:** the runtime resolves the name again for the actual request. The worker sends no cookies or credentials and only reads HTML (2 MB cap, 15 s timeout) |
| IDOR, cross-user access | Row-level security: users see only their own rows. Every API query is scoped to the verified user id. The outbox is not readable by users |
| E-mail injection | The recipient is the account's confirmed address, never request input. The subject has no line breaks or control characters (also enforced by a DB check). The body is plain text |
| Secrets | Service role, Resend key, worker secret and database password live only in Supabase secrets and Vault |
| Duplicate alerts | Alerts are sent only on a false → true transition. The unique dedupe key is `monitor:episode`, which is also the Resend idempotency key |
| Crashed or overlapping workers | Monitors and outbox rows are claimed with leases and `FOR UPDATE SKIP LOCKED`. Failures retry with exponential backoff; a monitor goes to `error` after 24 failures in a row |

## Known limits

- **Blocked stores.** Large stores (Amazon, Flipkart) often answer cloud servers with a bot check. The
  worker records this as `blocked` and retries with backoff. It never sends a false alert. Store
  pages that include schema.org product data work best.
- **Free-tier pausing.** Supabase pauses free projects after about a week without activity. If that
  happens, open the dashboard and restore the project. A paid plan or regular use avoids it.
- **Minimum interval.** 15 minutes, because the scheduler runs every 5 minutes.
