-- Newer Supabase projects no longer grant table privileges on new public tables by default, so the
-- first migration's revoke-only approach left service_role and authenticated with no access at all.
grant select, insert, update, delete on public.monitors to service_role;
grant select, insert, update, delete on public.monitor_checks to service_role;
grant select, insert, update, delete on public.notification_outbox to service_role;

-- Users read their own rows through the RLS select policies; writes stay service-role only.
grant select on public.monitors to authenticated;
grant select on public.monitor_checks to authenticated;
