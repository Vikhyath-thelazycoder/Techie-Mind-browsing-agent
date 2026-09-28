# Architecture

**Status:** Phase 0 foundation and Phase 1 agent core implemented. Security/privacy enforcement and model routing are next (Phases 2–3).

Source of truth: [TECHIE_MIND_SPEC.md](TECHIE_MIND_SPEC.md) and [master implementation plan.md](master%20implementation%20plan.md). This document describes what exists in the repository today.

## Core principle

**Reasoning ≠ authority.** Anything that proposes an action (in Phase 1: deterministic code; from Phase 3: models) emits a structured proposal. Only the local runtime binds it to a live observation (`Action` + 7-field `ActionBinding`), and the page-side executor re-checks that binding before touching the page.

## Phase 1 pipeline (as built)

```
side panel ──RUN_TASK (task port, own pages only)──► background task service
                                                        │
  agent-core runner (Tier 0, 0 model calls) ────────────┘
    resolveIntent ─► routeIntent ─► planGoals (navigate · search · open-result)
    for each goal:  observe ─► ground ─► bindAction ─► execute ─► settle ─► verify
                    └─ bounded recovery: L1 retry · L2 refresh · L3 re-ground ·
                       L4 next candidate · L5 alternative strategy · L6 handover
                                                        │ AgentHost
  ExtensionHost (BrowserAdapter + content protocol) ◄───┘
    navigate / goBack / inject-on-demand / OBSERVE / EXECUTE / PROBE (all contract-validated)
                                                        │
  content script (agent tab only) ──► perception: DOM + A11y observer, element registry,
                                      DOM version, executor (binding re-check), overlay
```

Every step emits a structured §60 event (TASK_STARTED … TASK_COMPLETED/FAILED) that is streamed live to the side panel timeline and recorded with per-stage timings in the task result.

## Navigation policy (Phase 1 correction)

`resolveIntent` (wording) → `currentContext` (open tab) → optional one-observation fit check → `decideNavigation` → [`resolveWebsite`: background probes → evidence scoring → in-tab confirmation] → `planGoals` (`use-context` or `navigate`, then search / open-result) → the same goal loop as before. Priority: current tab → URL/domain → named site → open page → intent default → search engine (last).

## Security + privacy (Phase 2)

observe → **privacy scan** (sanitize + tokenize into the task vault; in-page text scan → counts; injection scan) → ground (injected elements excluded) → bind → **firewall** (10 checks vs live probe) → execute → verify. Every network request → **outbound privacy gate**. Every event → privacy-engine redaction → masked → timeline + **hash-chained audit log** (persisted). Packages: `packages/privacy`, `packages/security`.

## Repository layout

```
apps/extension/src/background/  handler (one-shot), tasks (task port), host (AgentHost impl)
apps/extension/src/content/     on-demand content script: contract-validated OBSERVE/EXECUTE/PROBE
apps/extension/src/sidepanel/   UI: plan preview, live timeline, result, history
apps/extension/src/settings/    settings UI
packages/contracts/             Zod contracts (22 §9 types + ActionProposal + protocols + fingerprint)
packages/config/                single authoritative settings/model configuration
packages/telemetry/             masked structured logging, hash-chained audit, spans/percentiles
packages/browser/               BrowserAdapter (Chrome/Firefox), tabs, scripting, ports
packages/perception/            page-side: DOM observer, accessibility projection, executor, overlay
packages/agent-core/            intent, sites, router, plan, grounding, binding, verify, runner
tests/browser/                  real-Chromium: shell, agent on fixture sites, security, latency
tests/live/                     real-Chromium on live YouTube/Flipkart (acceptance + variations)
```

## Planned layers → location

| Layer (spec) | Package | Phase |
|---|---|---|
| Privacy engine, token vault, outbound gate (§13–17) | `packages/privacy` | 2 |
| Action firewall: risk, policy, prompt injection (§23, §68–71) | `packages/security` | 2 |
| Model router: Laya, Qwen, API gateway (§18–21) | `packages/models` | 3 |
| Local visual model (§12) | `packages/perception` (vision) | 4 |
| 12 skills (§30–52) | `packages/skills` | 6 |
| Voice + multilingual (§44–45) | `packages/voice`, `packages/i18n` | 7 |
| Monitoring backend (§38–43) | `apps/monitoring-server` | 8 |

## Trust boundaries

- **Web page → nothing.** Pages cannot reach the extension (no `externally_connectable`); ordinary pages contain no Techie Mind code.
- **Content script** answers only its own background (`sender.id` matches, no `sender.tab`) and parses every message with `ContentRequest` — which re-validates any `Action` in full.
- **Background** accepts one-shot requests and task-port connections only from its own extension pages (sender URL under the extension origin).
- **Host** refuses any action bound to a different tab (cross-tab safety) and navigates only to http(s).
- Extension-page CSP forbids eval and remote code; ESLint forbids eval, `new Function`, `javascript:` URLs and raw-HTML injection.
