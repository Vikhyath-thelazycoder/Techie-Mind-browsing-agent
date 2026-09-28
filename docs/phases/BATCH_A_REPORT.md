# Batch A Report — Phase 3 (Model Routing) + Phase 4 (Visual Perception)

**Status:** COMPLETE — 2026-09-28. Gates: Phase 3 9/9, Phase 4 7/7.
**Where:** built and tested in a cloud container. Laya and Ollama were not available there, so every
model tier was tested against stand-in servers that speak the real wire formats. The real-model
benchmark still has to be run on the Mac (see "Next on your Mac").

## What was built

**Phase 3 — the models help only when code is unsure.**
- Order: Code → Laya → `qwen2.5vl:7b` (or the configured gateway) → ask you. Confident commands
  make **0 model calls**.
- Code now marks sentences like "the samsung one" or "the one with 256 GB" as unsure. Before this,
  it wrongly treated them as website names.
- Laya answers typed choices only. It confirms plain searches ("iphone 15") without the 7B model
  and recognises page commands.
- Code re-checks every model answer. Typed text must be your own words. Sites must be named by you.
  Elements must be ones the model was shown. The firewall still authorizes every action.
- Privacy: model calls go through the outbound privacy gate. Your words and the page are
  tokenized/sanitized first ("98765 43210" → `PHONE_001`). The model sees at most 60 named elements
  and no field values.
- Laya adapter: `scripts/laya/laya_adapter.py`. It stays warm, is loopback-only, token-protected
  and size-bounded, has a health check, and comes with a launchd plist. Settings has a new Laya card.
- Per-tier outcome and latency are recorded in `TaskResult.models`, `timings.modelMs` and
  `MODEL_CALLED` events.

**Phase 4 — vision as a last resort.**
- It runs only when grounding found nothing **and** the page has visual-only elements (unnamed
  tiles or icons, images, canvas). A readable page makes 0 screenshots.
- Pipeline: the page reports where sensitive data sits (positions only) → the tab is captured →
  those regions are painted black inside the background → `qwen2.5vl:7b` returns a box → code maps
  it to one real page element → firewall → verified click. There are no coordinate clicks, and
  screenshots never go to a gateway.
- `npm run bench:models -- --vision` renders a test page and scores localization, IoU, latency and
  memory against real element positions.

## Tests

| Check | Result |
|---|---|
| Unit tests | 387/387 (+41 this batch) |
| Real Chrome (this container) | 43/44. The one failure is container-only: this Chromium lacks `sidePanel.getPanelBehavior` |
| New real-Chrome scenarios | "now open the buying guide one" via Laya → model; a page full of personal data (nothing personal sent); models down (code still works); "now open the red one" on image-only tiles via vision, **with pixel checks that email, phone and password were black in the image the model received**; readable page → no capture |
| Lint, typecheck, prettier, build | clean |
| Earlier phases | Phase 1 static/generic and the Phase 2 network gate re-run inside the verifiers. The full live-site regression is due at the Phase 5 milestone, as agreed |

## Problems found and fixed

1. **The privacy gate would have blocked every model call.** Our own ids (`task-<uuid>`) looked
   like secrets. Fixed.
2. **Random UUIDs sometimes read as phone numbers** (about 2% of ids). This was also the cause of an
   older, occasional drop in the privacy corpus precision (1.000 → 0.995). Fixed: detections inside
   UUIDs or digests are ignored, while a real phone number next to an id is still caught.
3. **The gate rejected the intent's `value` fields as raw page data.** Models now get a minimal,
   redacted reading.
4. **Tab capture needs `<all_urls>`.** Host access changed from http/https to `<all_urls>`.
   Injection stays http(s)-only in code; see SECURITY.md.

## Not done / honest gaps

- **No real Laya or Qwen runs yet.** Latency and accuracy are unmeasured.
- **Laya's raw output format is mapped defensively.** Run `--selftest` once to confirm the mapping.
- **The spec's in-browser vision option was not built.** That is Florence-2 on WebGPU/ONNX. It is
  documented as a comparison plan behind the same `locate` interface.
- **Visual privacy is DOM-driven.** There is no OCR of text inside images and no face-detection
  model (person photos are found by DOM hints). Vision sees the viewport only.

## Next on your Mac

```bash
npm install && npm run build            # reload the extension
ollama pull qwen2.5vl:7b                # already installed
~/.cache/techymind-laya/py311/bin/python scripts/laya/laya_adapter.py --selftest
~/.cache/techymind-laya/py311/bin/python scripts/laya/laya_adapter.py   # paste the token into Settings
npm run bench:models -- --vision        # → evidence/model-bench.json
```
