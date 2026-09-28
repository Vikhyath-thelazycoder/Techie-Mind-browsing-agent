# Security

**Status:** Phase 0 baseline + Phase 1 execution-boundary controls implemented and tested in real Chromium. Full action firewall (risk/policy/prompt injection) is Phase 2.

## Implemented in Phase 0

| Control | Where | Test evidence |
|---|---|---|
| Strict contracts reject unknown keys, unknown action types, script actions, non-http(s) navigation, out-of-range values | `packages/contracts` | `action.test.ts`, `contracts.test.ts` |
| Model output (`ActionProposal`) cannot carry a binding, tab id, JS or free text | `packages/contracts/src/action.ts` | `action.test.ts` |
| Targeted actions require a bound target; 7-field binding required | `Action` schema | `action.test.ts` |
| `PrivacyFinding` cannot hold a raw value | `packages/contracts/src/privacy.ts` | `contracts.test.ts` |
| `ModelRequest` only accepts a `SanitizedObservation` (`sanitized: true`) | `packages/contracts/src/model.ts` | `contracts.test.ts` |
| Background accepts only its own extension pages + schema-valid messages | `apps/extension/src/background/handler.ts` | `handlers.test.ts`, real Chromium |
| Content script answers only its own background; strict guard | `apps/extension/src/content/handler.ts` | `handlers.test.ts`, `guards.test.ts`, real Chromium |
| CSP: no eval, no remote scripts | manifest generator | `manifest.test.ts`, Phase 0 gate |
| Least-privilege permissions (`storage`, `tabs`, `sidePanel`) | manifest generator | `manifest.test.ts` |
| Lint bans eval / new Function / `javascript:` / raw HTML injection | `eslint.config.js` | positive control verified |
| Log masking + flat primitive log payloads + hash-chained audit | `packages/telemetry` | `telemetry.test.ts` |
| Non-disableable safety settings (financial safety, handover, Indian ID redaction) | `packages/config` | `settings.test.ts` |
| Local model URLs must be loopback; remote gateways https only | `packages/config` | `settings.test.ts` |
| No secrets committed; `.env` ignored; `.env.example` documented | repo | Phase 0 hygiene gate |

## Added in Phase 1

| Control | Where | Evidence |
|---|---|---|
| Zero code in ordinary pages; content script injected only into the agent's tab | manifest (no `content_scripts`), `ExtensionHost` | `extension.spec.ts` (ping fails before injection) |
| Content script re-validates every EXECUTE against the full `Action` contract | `apps/extension/src/content/handler.ts` | `content.test.ts`, `security.spec.ts` |
| Executor re-checks binding: document, origin, version, element, fingerprint, visibility, enabled | `packages/perception/src/executor.ts` | `executor.test.ts`, `security.spec.ts` (real Chromium, with positive control) |
| No page-side navigation; background navigates http(s) only | executor + `BrowserAdapter.navigateTab` | `security.spec.ts`, `adapter.test.ts` |
| Cross-tab: an action bound to another tab never executes | `ExtensionHost.execute` | `host-and-tasks.test.ts` |
| Task port accepts only own extension pages and contract-valid requests; one task at a time | `background/tasks.ts` | `host-and-tasks.test.ts`, `security.spec.ts` |
| Web pages cannot reach the extension runtime | no `externally_connectable` | `security.spec.ts` |
| Vault-token typing refused until the Phase 2 vault exists | executor | `executor.test.ts`, `security.spec.ts` |
| Bounded execution: step budget, task timeout, recovery ladder capped at 6 | runner | `runner.test.ts` |
| Purchases refused by the agent core | planner | `runner.test.ts` |

## Added in the Phase 1 correction

- Website probes run in the background with `credentials: 'omit'`, no referrer, https origins only (`https://<label>.<tld>/`), 4.5 s timeout, 256 KB body cap; candidates are derived only from `[a-z0-9-]` labels.
- Only the tab's origin is recorded in results; reused-tab targets drop query strings and fragments.
- The remembered agent tab stores a tab id only.
- CAPTCHA / bot-wall pages always hand over to the human and are never verified.
- Runtime source is scanned for the correction's acceptance brands and phrases (none present).

## Added in Phase 2 — Security + Privacy

- **Action firewall** (`packages/security`): 10 ordered checks in front of every action — schema, task binding, tab binding, target, origin, freshness, risk, privacy, injection/provenance, authorization. See [ACTION_FIREWALL.md](ACTION_FIREWALL.md).
- **Financial safety / human handover**: payment controls and payment URLs, OTP fields, CAPTCHAs and sign-in are never executed; the task stops with a precise instruction. Raw text into password fields is blocked.
- **Prompt-injection defense**: intent comes only from the user; typed text must come from the user's request; navigation only to hosts routed from it; injection-carrying elements are excluded and blocked; attempts are reported.
- **Privacy engine** (`packages/privacy`): layered detection with checksums, redaction/tokenization, memory-only vault, sanitized observations, in-page whole-text scan returning counts only. See [PRIVACY.md](PRIVACY.md).
- **Outbound privacy gate**: the only network path in runtime code (wire guard); blocks PII, secrets, raw DOM, schema-invalid payloads, private/loopback/non-https internet targets (SSRF).
- **Tamper-evident audit log**: persisted, hash-chained with canonical JSON, bounded ring with a verifiable anchor; detects altered, deleted and reordered records.
- **Threat model**: [THREAT_MODEL.md](THREAT_MODEL.md) — 16 threats with defenses, residual risk and tests.

## Reporting

Security issues: contact the project owner privately; do not open public issues containing exploit details.
