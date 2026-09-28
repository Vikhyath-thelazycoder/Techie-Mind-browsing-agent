# Model Routing

**Status:** Phase 3 complete (Batch A). Code → Laya → active model (local Ollama or the configured
gateway) → ask the user. Vision (tier 3) is Phase 4, see [PERCEPTION.md](PERCEPTION.md).

## The rule

Models **interpret**; code **re-checks**; the firewall **authorizes**. A model never receives the
browser, never produces an executable action, and never sees raw page content or raw personal data.

```
request ─► code (resolveIntent) ── sure (≥ CODE_CONFIDENCE 0.8) ─────────────────────► plan
               │ unsure / page reference ("the samsung one")
               ▼
           Laya (typed choice, 2.5 s timeout)
               ├─ "search", ≥ 0.75, no escalate → keep code's search reading ─────────► plan
               ├─ "page_command"                 → honest "can't do that yet"
               └─ anything else / unsure / down  ─┐
                                                   ▼
           active model (Ollama qwen2.5vl:7b, or the gateway; 30 s timeout)
               ├─ intent  → profileFromModel re-checks → plan
               ├─ element → must be an interactive element it was shown → open-element goal
               ├─ abstain → ask the user its question (HUMAN_REQUIRED, NEEDS_CLARIFICATION)
               └─ down / invalid / refused → code reading, or ask when code had none
```

## Tiers

| Tier | What | Where | Output | Budget |
|---|---|---|---|---|
| 0 Code | `resolveIntent`, router, grounding, verification | extension | IntentProfile | ~1 ms |
| 1 Laya | typed decision over 6 categories | `scripts/laya/laya_adapter.py`, warm process, loopback | `LayaClassification` | `LAYA_TIMEOUT_MS` 2.5 s |
| 2 Local model | interpretation of unclear requests | Ollama, `qwen2.5vl:7b` (text + vision) | `ModelInterpretation` | `MODEL_TIMEOUT_MS` 30 s |
| 4 Gateway | same as tier 2 when the gateway is the active model | OpenAI-compatible endpoint you run | `ModelInterpretation` | 30 s |

Constants live in `packages/agent-core/src/escalate.ts` (`CODE_CONFIDENCE` 0.8, `LAYA_CONFIDENCE`
0.75, `MODEL_CONFIDENCE` 0.5) and `packages/models/src/intelligence.ts` (timeouts, 60 s availability
cache).

**Which requests reach a model.** Only a reading code is unsure of: the generic "search the words"
fallback (confidence 0.5), unknown requests, and page references code must not guess
("the samsung one", "the one with 256 GB", "which of these" — `AMBIGUOUS_ENTITY`). Confident
commands ("open YouTube and search kannada songs", "play the second result") make **0 model
calls**; unsupported page commands ("scroll down") are refused by code without a model.

## One model, never substituted

The active model comes from `resolveActiveModel(settings)` — the same record the side panel chip
shows. Before a call, Ollama's `/api/tags` is checked (cached 60 s). If the configured model is not
installed the tier is `unavailable` with the reason ("qwen2.5vl:7b is not installed in Ollama (run:
ollama pull qwen2.5vl:7b)") — we **never substitute** another installed model. Ollama is called with
`keep_alive: 30m` so the model stays loaded between actions.

## Privacy

- Every model call goes through the outbound privacy gate (`gatedFetch`, purpose `model`). The gate validates the
  `ModelRequest` (schema), scans it **and** the provider wire body for PII, secrets and raw page keys,
  allows only loopback endpoints (or the one configured gateway host) and only `x-techie-mind-*`
  headers. A blocked call is outcome `blocked` — never repaired and re-sent.
- The request text is redacted with the task vault first: "call 98765 43210" reaches the model as
  "call PHONE_001". Tokens in a model's query are restored locally.
- The page reaches the model only as a `SanitizedObservation` trimmed by `summarizeForModel` to ≤ 60
  named, visible elements (no field values, no query string, no findings detail).
- The code reading shown to the model has no entities/constraints (their `value` fields are raw
  words and are refused by the gate).
- `TaskResult.models` records tier, model id, outcome, latency and a short reason — never prompts or
  page text.

## Authority (`profileFromModel`)

- a query must be the user's own words, in order (`fromUserWords`) — a model cannot choose what is
  typed; the firewall's provenance check is the backstop;
- a site must be named in the user's words and is routed by the deterministic router;
- an element must be one of the interactive elements in the summary the model saw; the click is then
  bound to the live observation and passes all 10 firewall checks (injected elements, payment
  controls, logins and CAPTCHAs are refused or handed over exactly as for code-proposed actions);
- confidence below `MODEL_CONFIDENCE` counts as abstain.

## Laya adapter

`scripts/laya/laya_adapter.py` keeps Laya MLX loaded in one process (launchd plist:
`scripts/laya/com.techiemind.laya.plist`). `GET /health`, `POST /v1/classify` (token header
`x-techie-mind-laya-token`, 16 KB body limit, choices validated, 127.0.0.1 only, no request logging).
The token is generated once into `~/.config/techie-mind/laya.token`; paste it in Settings → AI & Models
→ Laya. `--selftest` prints Laya's raw output for four sample requests so the answer mapping can be
confirmed on the Mac (`interpret()` turns any unrecognised shape into an escalation, never a guess).

## Latency

`StageTimings.modelMs` sums time in model tiers; `modelCalls` counts calls; each `MODEL_CALLED` event
carries tier, outcome and milliseconds. Real-model numbers come from `npm run bench:models` on the
machine with the models (writes `evidence/model-bench.json`: cold/warm p50/p95, valid-answer rate,
accuracy on a labelled set).

## Tests

- `packages/models/test/models.test.ts` — strict parsing, summary, Ollama/Laya wire formats,
  availability without substitution, failure outcomes, gate integration.
- `packages/agent-core/test/models.test.ts` — routing order, fallbacks, clarification, authority
  (invented query/site/element, injected element, payment control), tokens only, real gate.
- `tests/browser/models.spec.ts` — the built extension in Chromium with stand-in Laya/Ollama servers
  (real wire formats, simple visible rules). Stand-ins are not the models.
- Gates: [phases/PHASE_3_GATES.md](phases/PHASE_3_GATES.md), `node scripts/verify/phase3.mjs all`.
