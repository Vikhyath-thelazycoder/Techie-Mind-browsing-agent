# Pre-Batch-A bug fixes (user-reported, real Chrome, 2026-09-28)

Re-read this file after any context compaction. Tick an item only when its test passes.

- [x] B1 Follow-ups while a site is open go to Google ("now click the second product", "click the 2nd phone", "iphone 15" on Flipkart). Expected: act in the open tab; Google only when nothing fits.
- [x] B2 Browser commands the agent can't do yet ("scroll down", "go back", "add it to cart") get Google-searched. Expected: honest "can't do that yet", no search.
- [x] B3 "Open Flipkart iPhone" drops "iPhone". Expected: open Flipkart and search iPhone.
- [x] B4 "play a Kannada song" searches "a Kannada song". Expected: "Kannada song".
- [x] B5 A result link that opens a new tab (Flipkart product) makes the agent think the click failed and re-click → duplicate tabs. Expected: adopt the opened tab, verify it, never re-click.
- [x] B6 New command opens a fresh tab when the active tab is a browser page, ignoring the agent's own tab. Expected: reuse the agent tab.
- [x] Regression: `npm run typecheck`, `npm run lint`, `npm test` (346/346), `npm run build`, `npm run test:browser` (39/39) all green; Phase 1 static/generic and Phase 2 gate scans pass.
- [x] Short report: `docs/phases/BUGFIX_REPORT.md`.

Out of scope (Batch B): Chrome's autoplay block needs a real user click.
