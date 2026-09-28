# Browser Support

**Status:** Chrome MV3 builds and the Phase 1 agent is validated in real Chromium (fixtures + live sites). Firefox target builds and passes `web-ext lint`; it has not yet been run in a real Firefox.

| | Chrome | Firefox |
|---|---|---|
| Manifest | MV3 | MV3 |
| Background | module service worker (`background.service_worker`) | module background script (`background.scripts`) |
| Panel | `side_panel` + `sidePanel.setPanelBehavior` | `sidebar_action` + `sidebarAction.open()` from toolbar click |
| Settings | `options_page` | `options_ui` (`open_in_tab`) |
| Minimum | Chrome 116 | Firefox 142 (gecko id `techie-mind@sih26171.local`) |
| Content script | injected on demand via `scripting.executeScript` | same API (Firefox MV3) — not yet exercised |
| Validation | Playwright real-Chromium: 21 tests + 9 live-site tests | `web-ext lint`: 0 errors, 1 warning* |

\* The warning is Preact's internal `innerHTML` path for `dangerouslySetInnerHTML`; our source is lint-banned from using it, so the path is unreachable.

Shared code never touches browser-specific APIs directly: everything goes through `BrowserAdapter` (`packages/browser`). Both browsers expose the promise-based `chrome.*` namespace in MV3.

## Build & load

```bash
npm install
npm run build          # → apps/extension/dist/chrome and apps/extension/dist/firefox
```

- Chrome: `chrome://extensions` → Developer mode → *Load unpacked* → `apps/extension/dist/chrome`.
- Firefox: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `apps/extension/dist/firefox/manifest.json`.
