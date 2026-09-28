# Bug-fix report — user-reported real-Chrome bugs (before Batch A)

**Status:** DONE — 2026-09-28. Checklist: [BUGFIX_PLAN.md](BUGFIX_PLAN.md).

| # | Bug (user's wording) | Cause | Fix |
|---|---|---|---|
| B1 | "now click the second product" / "iphone 15" typed into Google | Parser only knew fixed shapes; "now …", "the 2nd phone" and bare queries fell to the Google fallback, which ignored the open tab | Conversational openers ("now", "ok", "then") are stripped; a click/open/select with a position accepts any item word; a bare query is offered to the open site first — Google only when the open page cannot search or nothing is open |
| B2 | "scroll down", "go back", "add it to cart" searched on Google | Same fallback | Refused honestly: "Techie Mind can't … pages yet" (`UNSUPPORTED_COMMAND`); no navigation, no search |
| B3 | "Open Flipkart iPhone" only opened Flipkart | Words after the site were dropped when there was no "search" verb | Leftover words after "open <site>" become the search query |
| B4 | "play a Kannada song" searched "a Kannada song" | Leading article kept | Leading "a"/"an" removed from queries |
| B5 | Product opened again and again | Store links open a new tab; the agent only watched its own tab, judged the click failed and clicked again | After a click that leaves the tab unchanged (2 s), the agent looks for a tab the click opened, switches to it and verifies it there — one click, one tab |
| B6 | Each command opened a fresh tab | With a browser page in front (e.g. `chrome://extensions`) the agent ignored its remembered tab | Reuses (and shows) the agent's own tab if it is still open on a web page |

**Tests (user's exact sentences first, then fixed):**

| Suite | Result |
|---|---|
| Unit + integration | 346/346 (+8: parser/navigation B1–B4, runner new-tab adoption B5, host B5/B6) |
| Real Chrome (local fixtures) | 39/39 (+1: open store → "now click the second product" on new-tab links → "iphone 15": one product tab, agent moves to it, search continues there, zero Google requests) |
| Lint, typecheck, build, Phase 1 static/generic scans, Phase 2 network-gate scan | pass |

**Not yet verified:** live Flipkart/YouTube. Per the batch rules, live-site tests run at the Phase 5 milestone. To try it yourself: `npm run build`, then reload the extension in `chrome://extensions`.

**Still open:** YouTube playback blocked by Chrome's autoplay rule (needs a real click) → Batch B. Commands refused under B2 (scroll, back, sort, filter, cart) become real actions in later phases; free-form wording beyond these patterns goes to the Phase 3 models (Laya → Qwen) in Batch A.
