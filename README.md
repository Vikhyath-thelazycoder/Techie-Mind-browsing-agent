# Techie Mind

Privacy-first autonomous browser agent for **SIH26171 — On-device Visual Perception for Light-weight Browser Agents** (ISRO / Department of Space).

> The model provides intelligence. The browser runtime provides authority. The privacy layer controls information. The action firewall controls execution. The verifier controls truth. The human remains the final authority.

**Current status:** Phase 0 (Foundation) complete — see [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Quick start

```bash
npm install
npm run build        # Chrome + Firefox extension builds
npm run verify       # all Phase 0 acceptance gates (typecheck, lint, unit, builds, real Chromium, docs, hygiene)
```

Load `apps/extension/dist/chrome` via `chrome://extensions` → *Load unpacked*.

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
| `tests/browser` | Real-Chromium tests of the built extension |
