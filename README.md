# Techie Mind

Privacy-first autonomous browser agent for **SIH26171 — On-device Visual Perception for Light-weight Browser Agents** (ISRO / Department of Space).

> The model provides intelligence. The browser runtime provides authority. The privacy layer controls information. The action firewall controls execution. The verifier controls truth. The human remains the final authority.

**Current status:** Phases 0–4 complete (Batch A: model routing + visual fallback) — see [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Quick start

```bash
npm install
npm run build        # Chrome + Firefox extension builds
npm run verify       # current acceptance gates (Phase 3; `npm run verify:phase4` for vision)
```

Load `apps/extension/dist/chrome` via `chrome://extensions` → *Load unpacked*.

### Local models (optional — the agent works with code alone)

```bash
ollama pull qwen2.5vl:7b                       # text + vision model (Settings → AI & Models)
~/.cache/techymind-laya/py311/bin/python scripts/laya/laya_adapter.py   # keeps Laya warm on 127.0.0.1:8765
# paste the token from ~/.config/techie-mind/laya.token into Settings → AI & Models → Laya
npm run bench:models -- --vision               # real latency/accuracy → evidence/model-bench.json
```

Models are asked only when code is unsure; see [docs/MODEL_ROUTING.md](docs/MODEL_ROUTING.md) and
[docs/PERCEPTION.md](docs/PERCEPTION.md).

## Documentation

- Master spec: [docs/TECHIE_MIND_SPEC.md](docs/TECHIE_MIND_SPEC.md)
- Master implementation plan: [docs/master implementation plan.md](docs/master%20implementation%20plan.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Design decisions: [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md)
- Testing: [docs/TESTING.md](docs/TESTING.md) · Performance: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Known limitations: [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)

## Workspace

| Path | Purpose |
|---|---|
| `apps/extension` | Chrome MV3 + Firefox extension (background, content script, side panel, settings) |
| `packages/contracts` | Strict runtime-validated contracts shared by browser, models and server |
| `packages/config` | Single authoritative settings and model configuration |
| `packages/telemetry` | Masked structured logging, hash-chained audit, latency measurement |
| `packages/browser` | Browser adapter over Chrome/Firefox APIs |
| `packages/models` | Model tiers: Laya, local Ollama / gateway, vision — clients, prompts, strict parsing |
| `tests/browser` | Real-Chromium tests of the built extension |
