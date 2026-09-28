# Monitoring

**Status:** Not started — Phase 8. `Monitor`, `MonitorResult`, `Notification` contracts exist from Phase 0.

## Scope

Server-owned monitors (PostgreSQL + scheduler + worker + transactional outbox) that keep running with the extension closed; false→true transition detection with dedupe; SSRF-safe fetching.

## References

- Spec §38–43, §85
- Plan §34–36
