# Deployment

**Status:** Local development build only (Phase 0). Store packaging, server deployment and credentials are later phases.

## Prerequisites

- Node.js ≥ 22 (`.nvmrc`), npm ≥ 10
- Google Chrome ≥ 116 and/or Firefox ≥ 142

## Develop

```bash
npm install
npm run build            # Chrome + Firefox → apps/extension/dist/{chrome,firefox}
npm run verify           # all Phase 0 acceptance gates
```

Load the build as described in [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md). After changing the logo, regenerate icons with `npm run icons -w @techie-mind/extension`.

## Configuration & credentials

Copy `.env.example` to `.env` for server-side components when they exist. The extension itself holds no secrets; API keys are never stored in browser settings (see TECHNICAL_DESIGN.md, decision 3).

## CI

`.github/workflows/ci.yml` runs install, lint, format check, typecheck, unit tests, both builds, `web-ext lint`, and the real-Chromium suite, and uploads browser evidence.
