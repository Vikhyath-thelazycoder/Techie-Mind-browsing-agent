# Technical Design

**Status:** Phase 0 decisions recorded. Extended in every phase.

## Toolchain

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript 5.9, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` | Contracts are the security boundary; the compiler must be as strict as possible. |
| Workspaces | npm workspaces | Works out of the box on the dev machine (pnpm/corepack shim was broken); no extra tooling. |
| Runtime validation | Zod 4 (`strictObject` everywhere) | Unknown keys are rejected, so a payload cannot smuggle extra fields (e.g. a raw secret). JSON Schema export via `z.toJSONSchema` for the server. |
| UI | Preact 10 | ~4 KB runtime vs ~45 KB for React; client resource use is 20% of the SIH score. |
| Bundler | Vite 7 (two builds per target) | ES-module pages + service worker; content script as a single classic IIFE (content scripts cannot be ES modules). |
| Unit tests | Vitest 3 | Fast, TS-native. |
| Browser tests | Playwright 1.63, Chromium persistent context | Loads the real built extension. |
| Firefox validation | `web-ext lint` (Mozilla addons-linter) | Official manifest/code validation. |
| Lint/format | ESLint 9 flat config + typescript-eslint, Prettier 3 | Security rules (no eval / raw HTML) are errors. |

## Decisions (Phase 0)

1. **Product name "Techie Mind".** The reference screenshots show "TechyMind"; the master spec names the product "Techie Mind". The spec is authoritative; the name lives in one constant (`PRODUCT_NAME`) and the manifest. *Pending owner confirmation.*
2. **One authoritative model selection.** Settings store only `activeProvider`; the model id always comes from that provider's own record, and every layer resolves it via `resolveActiveModel`. An earlier draft stored a separate `active.modelId`, which could pair one provider with another's model — found during implementation, fixed, and covered by a regression test.
3. **No API keys in browser settings.** The settings schema rejects unknown keys such as `apiKey`. Credentials go to the server-side gateway (Phase 3). The reference UI's API-key fields are therefore replaced by an explanatory note.
4. **Profile data is not a setting.** Name/email/phone/address are PII and will live in the encrypted local token vault (Phase 2). The Profile page explains this instead of storing plain values.
5. **Content script has no Zod.** It runs in every page, so it uses a dependency-free guard (`@techie-mind/contracts/guards`) that is tested to never accept anything the Zod contract rejects. Result: 845 B instead of 104.8 KB.
6. **Sender trust is by URL, not by "has no tab".** The side panel UI can be opened in a full tab; trust = `sender.id` is ours AND `sender.url` is under our extension origin. Content scripts always report the web page URL. Found by the real-Chromium test, fixed, regression-tested.
7. **System font stack.** Extension pages load no remote fonts (privacy: no network on open). Visual weight is matched with font weights instead of a specific typeface.
8. **Light theme only** (spec §4 "white/light interface").
9. **Safe default autonomy:** `ask-before-acting`. Payments/OTP/CAPTCHA hand over regardless of autonomy.
10. **Firefox minimum 142.0** — required for `data_collection_permissions` (AMO) on desktop and Android.
11. **Build warnings:** only Rollup `INVALID_ANNOTATION` from `node_modules` is filtered (Zod comments). Implemented with `onLog` because `@preact/preset-vite` replaces `onwarn`.

## Messaging protocol

| Message | From → To | Schema |
|---|---|---|
| `HEALTH_REQUEST` → `HEALTH_RESPONSE` | extension page → background | `HealthRequest` / `HealthResponse` |
| `OPEN_SETTINGS` → `OK` | extension page → background | `OpenSettingsRequest` / `OkResponse` |
| `CONTENT_PING` → `CONTENT_PONG` | background → content script | `ContentPing` / `ContentPong` |
| any failure | — | `ErrorResponse` (`INVALID_MESSAGE`, `UNTRUSTED_SENDER`, `INTERNAL`) |

## Settings storage

`chrome.storage.local["techieMind.settings"]`, validated by `Settings` (schemaVersion 1). Missing sections are filled from defaults; any invalid present value rejects the whole load and the UI shows an error instead of partially applying it.

## Decisions (Phase 1)

12. **On-demand content script (supersedes decision 5).** The content script is no longer declared for every page. The background injects it with `chrome.scripting` only into the tab the agent is working in (`scripting` permission + http(s) host access — the same site access Phase 0 already held via content-script matches). Ordinary browsing carries **zero** Techie Mind code. Because it no longer runs everywhere, it now uses the full Zod contracts (124 KB raw / 37 KB gzip, loaded only into the agent's tab) instead of a hand-written guard; the Phase 0 guard module was removed.
13. **Clause-based deterministic intent (Tier 0).** No model is called in Phase 1. The resolver finds the site mention, the command verb (English, Hinglish and romanised-Kannada prefix/postfix forms) and takes the query from the verb's side of the clause. It keeps the user's original casing for the typed query.
14. **Routing data only, no site scripts.** `sites.ts` holds domain/home URL/aliases for known sites. There are no selectors or per-site action sequences anywhere in runtime code; the verifier scans runtime source for the acceptance phrases.
15. **Computed accessibility projection.** Chrome's native AX tree needs the `debugger` permission (with a visible "being debugged" bar) and has no Firefox equivalent, so roles/names/states are computed from the DOM following WAI-ARIA/HTML-AAM/accname rules.
16. **Synthetic, standards-shaped events.** Content scripts cannot create trusted input. TYPE uses the native value setter + `input`/`change` (observed by React/Polymer); Enter emulates implicit form submission (`keydown` → `form.requestSubmit()` unless the page cancelled the key). A consequence is recorded in KNOWN_LIMITATIONS: sound autoplay cannot be unlocked by an extension.
17. **Binding checks at the last hop.** Before touching the page, the executor re-checks document id, origin, observation version, element existence, fingerprint (tag+role+name), visibility and enabled state. The observation version may be older than the live DOM (busy pages mutate constantly); identity of the *target* is what must match. The full action firewall (risk, policy, prompt injection) is Phase 2.
18. **Verification waits for evidence.** A search is verified only when relevant result links are visible (bounded 6 s re-observation). Playback is verified only by *sustained* playback of the page's primary player (two samples ≥1.2 s apart, position advanced). Both rules were added after live tests exposed false positives (results not yet rendered; preview players).
19. **Autoplay-blocked handover.** When a real player is present but will not start, the agent hands over ("Press Play") instead of trying other results.
20. **Task service lock released before the result is announced**, so back-to-back tasks are never refused as busy (race found by the latency benchmark; regression-tested with a negative control).
21. **Evidence lives in `evidence/`**, not under Playwright's `test-results/` (which Playwright wipes at the start of every run).

## Decisions (Phase 1 correction)

22. **Decide where to act before navigating.** `decideNavigation()` combines the wording with the open tab (`AgentHost.currentContext()`) in a fixed priority: explicit current tab → explicit URL/domain → named website → open page that can satisfy the request → intent default → search engine last. The resolver only *proposes* `targetSource`/`navigationPolicy`; the planner finalises them.
23. **Website names are resolved from evidence, not a list.** Candidate domains are probed from the background (https, no cookies, no referrer, 4.5 s, 256 KB) and scored on self-identification, host name, redirect convergence and "moved to" notices; placeholders and unrelated redirects are rejected; near-equal verified sites are an ambiguity handover. Inconclusive probes (bot protection resets non-browser requests) are confirmed in the real tab, accepted only if the page names itself after the brand.
24. **Reuse is a step, not an absence.** A reused tab gets a `use-context` step that re-confirms the host, so reports always show where the task ran.
25. **Task continuity without conversation memory.** A follow-up command works from the active tab (or the remembered agent tab) and reads the current query from the page's own search field.
26. **Challenge pages are handed over.** CAPTCHA/bot-wall interstitials (path, title, headings, challenge frames) are never verified results; automatic JS checks get 10 s to clear.
27. **Busy pages settle.** A page that is loaded and has kept the same URL/document for 2.5 s counts as settled even if its DOM never stops changing (auto-playing heroes).

## Decisions (Phase 2)

28. **Two new packages, one direction of trust.** `@techie-mind/privacy` (detection, redaction, vault, sanitization, outbound gate) and `@techie-mind/security` (risk, firewall, injection) are pure and browser-neutral; the runner owns one firewall and one vault per task; the extension only adds transport.
29. **Provenance is the injection defense.** Detecting injected text is best-effort; what makes injection harmless is that an action is only authorized if it follows from the user's words (text to type ⊆ request, navigation ⊆ routed hosts). Detection reports and removes lure candidates.
30. **Stale vs. policy failures.** Firewall target/origin/freshness failures are mapped to the page-side rejection codes so the Phase 1 recovery ladder re-grounds; all other failures hand over.
31. **Freshness on the runtime clock.** Observation age is measured from when the runtime received it, not the page's timestamp.
32. **Page text is scanned in the page.** The DOM observation stays small (grounding needs interactive/semantic nodes); a separate in-page scan returns only counts per kind and injection attempts.
33. **Titles are content.** Evidence and events carry hosts, never page titles (they can hold names no pattern detects).
34. **Canonical audit hashing.** Hashes cover canonical JSON (sorted keys) because extension storage reorders object keys.
35. **Logs are redacted by the privacy engine** (injected into the logger; telemetry keeps no dependency on privacy), then masked; history keeps the user's own request (for Rerun) and redacts everything page-derived.

## Decisions (Batch A — Phase 3 + 4)

36. **Models plug in through one seam.** `@techie-mind/models` implements `Intelligence` (`classify` = Laya, `interpret` = the active model, `locate` = local vision) over an injected `ModelTransport`. The runner depends only on the interface; the extension supplies a transport over `gatedFetch`; tests supply stand-ins. Without `intelligence` the runner behaves exactly as in Phase 1–2.
37. **Code decides when to ask a model.** Only readings below `CODE_CONFIDENCE` (0.8), unknown requests and page references ("the samsung one" — `AMBIGUOUS_ENTITY`) are escalated. The page-reference rule fixed a Phase 1 gap: code was *wrongly sure* such sentences named a website ("samsung one").
38. **Laya is a typed gate, not a generator.** It can confirm code's plain-search reading or recognise a page command — the two cases where it saves a 7B call — and otherwise passes the request up.
39. **Model answers are re-checked by code (`profileFromModel`).** Queries must be the user's own words, sites must be named by the user and are routed deterministically, elements must be interactive elements the model was shown. The firewall remains the final authority.
40. **The gate knows model traffic.** `OutboundRequest` gains `wire` (provider body, scanned with the ModelRequest), `x-techie-mind-*` headers only, and `images` (visual grounding only, locally redacted, ≤1, bounded; inserted after all text checks via `"<image:N>"` placeholders so base64 is never scanned as text). Two real bugs surfaced by the real-Chrome test and fixed: our own ids (`task-<uuid>`, `obs-task-<uuid>-N`) looked like entropy secrets, and digit runs inside random UUIDs looked like phone numbers (~2% of ids — also the source of a pre-existing flake in the privacy corpus metric).
41. **Models see a minimal, redacted reading.** The request is vault-tokenized; the code reading has no entities/constraints (their `value` keys are refused by the gate); the page is `summarizeForModel(sanitizeObservation(...))` — ≤ 60 named elements.
42. **One vision-capable local model.** `qwen2.5vl:7b` serves text and vision (installed; one resident model). The model name stays one setting; the default changed from `qwen2.5:7b`. Availability is checked via `/api/tags` (60 s cache) and never substituted.
43. **Vision is a fallback with a local privacy boundary.** `visionWorthTrying` (visual-only elements present) + grounding failure → in-page `PRIVACY_REGIONS` (geometry only) → `captureVisibleTab` → background `OffscreenCanvas` paint-over → local model box → `groundRegion` to one DOM element → firewall. No coordinate clicks. Screenshots never go to a gateway.
44. **`<all_urls>` host access.** Required by `tabs.captureVisibleTab`; scripting remains http(s)-only in code.
45. **Persistent Laya adapter.** `scripts/laya/laya_adapter.py` (loopback, token, 16 KB, typed answers, defensive mapping of Laya's output with `--selftest` to confirm on the Mac); launchd plist provided.
