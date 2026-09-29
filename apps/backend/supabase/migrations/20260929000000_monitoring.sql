-- Techie Mind persistent monitoring (spec §38–43, master plan Phase 8).
--
-- Extension → monitor-api (authenticated) → monitors table
-- pg_cron → monitor-worker → claim (locked) → safe fetch → evaluate → transition → outbox → email
--
-- The backend owns persistence: monitors keep running when the browser is closed. Users can only
-- ever see their own monitors (row-level security); every write goes through the monitor-api Edge
-- Function, which validates the URL (SSRF rules) and takes the e-mail address from the verified
-- account — never from the request.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ── monitors ───────────────────────────────────────────────────────────────────────────────────

create table if not exists public.monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 2048),
  label text not null default '' check (length(label) <= 200),
  kind text not null check (kind in ('price-below', 'content-changed', 'available')),
  threshold numeric check (threshold is null or threshold > 0),
  currency text check (currency is null or currency in ('INR', 'USD', 'EUR', 'GBP')),
  interval_minutes int not null default 60 check (interval_minutes between 15 and 10080),
  status text not null default 'active'
    check (status in ('active', 'paused', 'cancelled', 'error')),
  -- Taken from the signed-in account by monitor-api; never from request input.
  notify_email text not null check (length(notify_email) between 3 and 320),
  -- Server-owned evaluation state.
  next_run_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_value numeric,
  last_hash text,
  last_available boolean,
  condition_met boolean,
  -- Incremented on every false → true transition; part of the notification dedupe key.
  episode int not null default 0,
  consecutive_failures int not null default 0,
  last_error text,
  -- Worker lease (locking): a claimed monitor is invisible to other workers until it expires.
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_needs_threshold check (kind <> 'price-below' or threshold is not null)
);

create index if not exists monitors_due on public.monitors (next_run_at) where status = 'active';
create index if not exists monitors_user on public.monitors (user_id);

create table if not exists public.monitor_checks (
  id bigserial primary key,
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  checked_at timestamptz not null default now(),
  outcome text not null check (outcome in ('ok', 'blocked', 'error')),
  observed_value numeric,
  content_hash text,
  available boolean,
  condition_met boolean,
  transition boolean not null default false,
  http_status int,
  error text check (error is null or length(error) <= 300)
);

create index if not exists monitor_checks_recent on public.monitor_checks (monitor_id, checked_at desc);

-- ── notification outbox (transactional: written in the same transaction as the check) ─────────

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.monitors (id) on delete cascade,
  user_id uuid not null,
  channel text not null default 'email' check (channel = 'email'),
  recipient text not null check (length(recipient) between 3 and 320),
  subject text not null check (length(subject) <= 200 and subject !~ '[\r\n]'),
  body text not null check (length(body) <= 4000),
  -- One notification per monitor per transition: duplicates are suppressed by this key.
  dedupe_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists outbox_due on public.notification_outbox (next_attempt_at)
  where status in ('pending', 'sending');

-- ── row-level security (no IDOR, no cross-user access) ───────────────────────────────────────

alter table public.monitors enable row level security;
alter table public.monitor_checks enable row level security;
alter table public.notification_outbox enable row level security;

drop policy if exists monitors_select_own on public.monitors;
create policy monitors_select_own on public.monitors
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists monitor_checks_select_own on public.monitor_checks;
create policy monitor_checks_select_own on public.monitor_checks
  for select to authenticated using (
    exists (
      select 1 from public.monitors m
      where m.id = monitor_checks.monitor_id and m.user_id = (select auth.uid())
    )
  );

-- No insert/update/delete policies: writes happen only through monitor-api and the worker
-- (service role). The outbox (recipients, e-mail bodies) is not readable by any user.
revoke all on public.notification_outbox from anon, authenticated;
revoke insert, update, delete on public.monitors from anon, authenticated;
revoke insert, update, delete on public.monitor_checks from anon, authenticated;

-- ── worker functions (service role only) ─────────────────────────────────────────────────────

-- Claim due monitors with a lease. FOR UPDATE SKIP LOCKED: two overlapping worker runs never
-- check the same monitor at the same time.
create or replace function public.claim_due_monitors(p_limit int, p_lease_seconds int)
returns setof public.monitors
language sql
security definer
set search_path = public
as $$
  update public.monitors m
     set locked_until = now() + make_interval(secs => p_lease_seconds)
   where m.id in (
     select id from public.monitors
      where status = 'active'
        and next_run_at <= now()
        and (locked_until is null or locked_until < now())
      order by next_run_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked
   )
  returning m.*;
$$;

-- Record one check atomically: history row, monitor state, next run (with backoff on failure) and,
-- on a transition, the outbox row — all in one transaction.
create or replace function public.complete_check(
  p_monitor uuid,
  p_outcome text,
  p_value numeric,
  p_hash text,
  p_available boolean,
  p_condition_met boolean,
  p_notify boolean,
  p_subject text,
  p_body text,
  p_http_status int,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.monitors;
  v_episode int;
  v_backoff int;
  v_notify boolean := false;
begin
  select * into m from public.monitors where id = p_monitor for update;
  if not found or m.status <> 'active' then
    update public.monitors set locked_until = null where id = p_monitor;
    return;
  end if;

  if p_outcome = 'ok' then
    v_notify := coalesce(p_notify, false);
    v_episode := m.episode + case when v_notify then 1 else 0 end;
    update public.monitors
       set last_checked_at = now(),
           last_value = coalesce(p_value, last_value),
           last_hash = coalesce(p_hash, last_hash),
           last_available = coalesce(p_available, last_available),
           condition_met = p_condition_met,
           episode = v_episode,
           consecutive_failures = 0,
           last_error = null,
           locked_until = null,
           next_run_at = now() + make_interval(mins => interval_minutes),
           updated_at = now()
     where id = p_monitor;
    if v_notify then
      insert into public.notification_outbox (monitor_id, user_id, recipient, subject, body, dedupe_key)
      values (
        m.id,
        m.user_id,
        m.notify_email,
        left(regexp_replace(p_subject, '[\r\n]+', ' ', 'g'), 200),
        left(p_body, 4000),
        m.id::text || ':' || v_episode::text
      )
      on conflict (dedupe_key) do nothing;
    end if;
  else
    -- Retry with exponential backoff (5, 10, 20 … minutes, never longer than the interval).
    v_backoff := least(m.interval_minutes, 5 * (2 ^ least(m.consecutive_failures, 6))::int);
    update public.monitors
       set last_checked_at = now(),
           consecutive_failures = consecutive_failures + 1,
           last_error = left(p_error, 300),
           locked_until = null,
           status = case when consecutive_failures + 1 >= 24 then 'error' else status end,
           next_run_at = now() + make_interval(mins => greatest(v_backoff, 5)),
           updated_at = now()
     where id = p_monitor;
  end if;

  insert into public.monitor_checks (
    monitor_id, outcome, observed_value, content_hash, available, condition_met, transition,
    http_status, error
  ) values (
    p_monitor, p_outcome, p_value, p_hash, p_available, p_condition_met, v_notify,
    p_http_status, left(p_error, 300)
  );

  -- Keep the history bounded (latest 200 checks per monitor).
  delete from public.monitor_checks
   where monitor_id = p_monitor
     and id < (
       select id from public.monitor_checks
        where monitor_id = p_monitor
        order by id desc offset 199 limit 1
     );
end;
$$;

-- Claim notifications to send (lease + attempt count). A crashed send is retried after the lease;
-- the e-mail provider receives the dedupe key as its idempotency key, so a retry never doubles.
create or replace function public.claim_outbox(p_limit int, p_lease_seconds int)
returns setof public.notification_outbox
language sql
security definer
set search_path = public
as $$
  update public.notification_outbox o
     set status = 'sending',
         attempts = attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where o.id in (
     select id from public.notification_outbox
      where status in ('pending', 'sending')
        and next_attempt_at <= now()
        and (locked_until is null or locked_until < now())
      order by created_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked
   )
  returning o.*;
$$;

create or replace function public.complete_outbox(p_id uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ok then
    update public.notification_outbox
       set status = 'sent', sent_at = now(), locked_until = null, last_error = null
     where id = p_id;
  else
    update public.notification_outbox
       set status = case when attempts >= 6 then 'failed' else 'pending' end,
           next_attempt_at = now() + make_interval(mins => (2 ^ least(attempts, 8))::int),
           locked_until = null,
           last_error = left(p_error, 300)
     where id = p_id;
  end if;
end;
$$;

revoke execute on function public.claim_due_monitors(int, int) from public, anon, authenticated;
revoke execute on function public.complete_check(uuid, text, numeric, text, boolean, boolean, boolean, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.claim_outbox(int, int) from public, anon, authenticated;
revoke execute on function public.complete_outbox(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.claim_due_monitors(int, int) to service_role;
grant execute on function public.complete_check(uuid, text, numeric, text, boolean, boolean, boolean, text, text, int, text) to service_role;
grant execute on function public.claim_outbox(int, int) to service_role;
grant execute on function public.complete_outbox(uuid, boolean, text) to service_role;

-- ── scheduler ─────────────────────────────────────────────────────────────────────────────────
-- Every 5 minutes pg_cron calls the worker. The worker URL and its shared secret live in Supabase
-- Vault (created once during setup — see docs/MONITORING_BACKEND.md), never in this file.

select cron.unschedule(jobid) from cron.job where jobname = 'techie-mind-monitor-worker';

select cron.schedule(
  'techie-mind-monitor-worker',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'monitor_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'monitor_worker_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'monitor_worker_url');
  $$
);
