# Perception

**Status:** Levels 1–3 (Phase 1) validated in real Chromium and on live sites. Level 4 — the on-demand visual fallback — implemented in Phase 4 (Batch A) and validated in real Chromium with a stand-in vision server; real-model accuracy/latency come from `npm run bench:models -- --vision` on the machine with the model.

## Level 1 — DOM observer (`packages/perception/src/observer.ts`)

Runs in the agent's tab only (content script injected on demand). Collects interactive and semantic elements — links, buttons, inputs, textareas, selects, `[role]`, contenteditable, focusable elements, h1–h3, media — **including open shadow roots**. For each node: tag, role, accessible name, visible text (links/buttons/headings), selected attributes, input type, owning form, current value (editable controls, local only), visibility (`checkVisibility` + non-zero box), interactive/editable flags and page-coordinate bounding box. Derived attributes: `tm:form-role`, `tm:form-action`, `tm:landmark`. Capped at 1,500 nodes, prioritising editable fields and buttons.

Observations never leave the browser (they contain raw page content); Phase 2 adds the privacy engine that produces `SanitizedObservation` for any model.

## Level 2 — Accessibility projection (`accessibility.ts`)

Computed ARIA role (explicit or implicit per HTML-AAM), accessible name (accname order: `aria-labelledby` → `aria-label` → `<label>` → button value/alt → placeholder/title → content), states (disabled, readonly, required, checked, expanded/collapsed, focused, hidden) and nearest landmark. See TECHNICAL_DESIGN decision 15 for why it is computed rather than read from Chrome's native tree.

## Identity and versioning (`registry.ts`)

- **Element ids** (`el-N`) are stable for the lifetime of a document (WeakMap/WeakRef — no leaks).
- **Document id** is minted per document when the script is injected; a navigation produces a new id.
- **DOM version** increments once per batch of structural mutations (MutationObserver).
- **Fingerprint** = FNV-1a of tag|role|name, computed identically at binding time and at execution time.

## Level 3 — Semantic grounding (`packages/agent-core/src/grounding.ts`)

Pure, explainable scoring over an observation — no selectors, no per-site code:

| Grounder | Positive signals | Exclusions / penalties |
|---|---|---|
| Search field | type=search, role searchbox/combobox, search wording in labels/placeholder/name/class, common query names (q, query, search_query…), search form (role or action), banner/search landmark, near top, wide | password/email/tel/number/date…, newsletter/login/coupon/PIN/OTP wording, hidden, disabled |
| Submit control | same form as field, type=submit, search/go label, adjacent to field | clear/voice/camera/lens/filter/back controls excluded |
| Search toggle | button/link with search wording, near top | advanced/voice/image search |
| Results | visible links outside header/nav/footer with query-term overlap (plural-folded), all-terms bonus, descriptive, prominent | fragment/`javascript:` links, labels < 8 chars |

Grounding outputs carry reasons (e.g. `type=search, inside search form, near top`) that are emitted in `TARGET_GROUNDED` events.

## Validated on

Local fixture sites reproducing real patterns (GET form with decoys; script-driven search without `<form>` behind a login overlay; collapsed search; re-mounting field; button-only submit; video site) and live youtube.com and flipkart.com (tests/browser and tests/live).

## Level 4 — Local visual perception (Phase 4)

Vision is a **fallback**, never the first look (spec §11–12). It runs only when all of these hold:

1. semantic grounding found nothing usable — no result link for "open the second result", or a page
   reference ("the red one") that neither code nor the text model could pin to a named element;
2. the page has something only a picture can describe — `visionWorthTrying(obs)`: a visible control
   without an accessible name, an `img`/`svg`/`canvas`/`picture`/`video`. On a text-only page a
   screenshot adds nothing, so vision is not run and the user is asked instead;
3. a local vision-capable model is configured (the gateway never receives screenshots).

A page the agent can read makes **0 captures and 0 vision calls** (unit and real-Chrome tests).

### Pipeline

```
grounding found nothing ─► visionWorthTrying? ─► PRIVACY_REGIONS (in the page: geometry only)
   ─► tabs.captureVisibleTab ─► redactCapture (background, OffscreenCanvas): scale to 1008 px wide,
      paint every sensitive region black ─► gate (image: visual grounding only, redacted, ≤1, bounded)
   ─► Ollama qwen2.5vl:7b: {"found": true, "box": [x1,y1,x2,y2]} or {"found": false}
   ─► parseLocation (strict: inside the image, positive area) ─► regionToPage (scale + scroll)
   ─► groundRegion: ONE visible interactive DOM element (centre inside / ≥50 % covered) or none
   ─► bound CLICK on that element ─► the same 10 firewall checks ─► verified
```

- **`sensitiveRegions`** (`packages/privacy/src/detect.ts`, run by the content script): rectangles of
  visible text spans the detectors flag, sensitive or filled fields (passwords, cards, OTPs … by
  meaning, whatever they hold), and — with face blurring on — images whose DOM hints say they show
  people (avatar, profile, portrait, person …). Returns geometry only, never text.
- **`redactCapture`** (`apps/extension/src/background/capture.ts`): the raw capture exists only inside
  this function; the returned `RedactedImage` is the only thing the agent ever holds. Width is a
  multiple of 28 (Qwen2.5-VL's patch size) so the model does not resize it and its box coordinates
  map back exactly.
- **`groundRegion`** (`packages/agent-core/src/vision.ts`): no element under the box → no click and a
  handover. The agent never clicks raw coordinates.
- Actions from vision are `proposedBy: 'vision'`; injected elements are blocked and payment controls
  handed over exactly as for code-proposed actions (tests).
- Timing: `StageTimings.visionMs` = capture + redaction + vision model; each call is in
  `TaskResult.models` (tier `vision`).
- Host permission: `tabs.captureVisibleTab` requires `<all_urls>` (see SECURITY.md); scripting stays
  http(s)-only in code.

### Model choice and the in-browser comparison

The working fallback uses the local `qwen2.5vl:7b` already installed for text (one model resident in
memory, no second download). The spec's preferred in-browser path — **Florence-2-base-ft** quantized
through Transformers.js / ONNX Runtime Web on **WebGPU** (WASM fallback) — is not built in this batch.
Comparison plan (no model is declared "best" without evidence, plan §16): run the same rendered
benchmark set (`scripts/bench/vision.ts`: image tiles and icon-only buttons with DOM ground truth)
through both, and compare localization accuracy, IoU, cold/warm latency, memory, bundle size and
browser compatibility. The `Intelligence.locate` interface is the seam: an in-browser locator can
replace the Ollama one without touching the runner.

### Limitations (Phase 4)

- Face detection is not a model: person photos are recognised by DOM hints only. Text drawn inside
  images or canvas is not OCR-scanned, so it is not painted over (DOM text and fields are).
- Only the visible viewport is captured; targets below the fold need a scroll the agent does not yet
  perform (page commands arrive later).
- Real-model localization accuracy is unmeasured here: run `npm run bench:models -- --vision` on the
  Mac (writes `evidence/model-bench.json`).
