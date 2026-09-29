# Monitoring

**Status:** Complete in Batch C (Phase 8). Monitors are server-owned: Supabase Postgres, pg_cron as
the scheduler, an Edge Function worker and a transactional outbox with e-mail. They keep running
while the extension, Chrome or the Mac is closed.

- Setup, architecture and security: [MONITORING_BACKEND.md](MONITORING_BACKEND.md)
- Code: `apps/backend/supabase/` (migration, `monitor-api`, `monitor-worker`, `_shared`)
- Extension: `apps/extension/src/shared/monitoring-client.ts`, Settings → Monitoring, and the
  `monitor-page` skill
- Conditions:
  - price at or below a target;
  - back in stock;
  - page content changed.
- Alerts are sent only on a false → true transition, with a unique dedupe key.

## References

- Spec §38–43, §85
- Plan §34–36
