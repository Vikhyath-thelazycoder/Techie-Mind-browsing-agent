# Batch B Report — Phase 5 (Real Agent Workflows) + Phase 6 (All 12 Skills)

**Status:** COMPLETE — 2026-09-29. Gates: Phase 5 8/8, Phase 6 7/7 (cloud container).
**Where:** cloud container, built on `main` including the Batch A Mac fixes (`0a915e6`).
**Not yet done:**
- The live websites (YouTube, Flipkart, Amazon) are blocked by this container's network policy, so
  the **Phase 5 live milestone runs on the Mac** through the local-sync prompt.
- The real models were not available here.

## What was built

**Phase 5 — real workflows (no site code).**
- **Generic extraction in the page.** Result cards give title, price, currency, rating and link.
  Struck-through old prices are ignored. It also reads main text and data tables.
- **"laptops under ₹50,000":** search, then read the results and keep what fits (spec acceptance
  test 4).
- **Pick by value:** "open the cheapest one", "the most expensive", "the top rated one". No model
  call is needed; this fixes the Mac miss where Qwen answered "cheapest" with a search.
- **Page commands are real now:** scroll up/down, go back/forward, add to cart (verified by the cart
  count or an "added" message), go to cart. A checkout button is handed over as payment. The agent
  never passes it.
- **Forms:** your profile is saved encrypted in Settings → Profile (AES-GCM, non-extractable key).
  - "fill my delivery address" maps fields by meaning and types each value through a vault token.
  - Each value is checked afterwards, and nothing is submitted.
  - Passwords, OTPs and card fields are never filled.
- **Summaries:** from the page's own text, redacted, written by the local model when available and
  taken from the page otherwise.
- **YouTube play past the autoplay block:** a trusted browser click (`chrome.debugger`) on the video
  result, only after the firewall approved the click. The page then has a real user gesture and plays
  with sound. It's a setting; with it off, the agent says "Press Play" as before.
- **Output card** in the side panel shows items, summaries and lists. History stores a redacted copy.

**Phase 6 — all 12 skills.** Each has a manifest, natural wording plus `/skill-id`, an executor on
the same verified pipeline, and tests:
- `summarize-page`, `extract-data` (CSV/JSON export), `screenshot-walkthrough` (redacted PNG with
  numbered marks), `save-page` (Markdown file with personal data replaced), `fill-form`.
- `compare-prices` (two or more named stores; every price is read from that store's page, never
  estimated), `find-alternatives` (drops the item itself, applies the budget), `deep-research` (up to
  3 sources, every bullet cited).
- `manage-bookmarks`, `organize-tabs` (tab groups by site; duplicates are closed only when asked, and
  never pinned or active tabs), `read-later` (address and title only), `monitor-page` (stored with
  the current price; checking arrives with the Batch C backend).

## Tests

| Check | Result |
|---|---|
| Unit | **430/430** (+37 since Batch A: workflows, extraction, skills, executor) |
| Real Chrome | **55/56**. The one failure is the known container-only `sidePanel.getPanelBehavior` |
| New real-Chrome scenarios | Workflows (6):<br>• under ₹50,000 → cheapest → back → scroll<br>• add to cart → cart → checkout handed over<br>• profile saved encrypted → form filled, not submitted, nothing leaked<br>• summary<br>• trusted play, with `userActivation` and unmuted playback checked in the page<br>• trusted play off → Press Play<br>Skills (6):<br>• bookmarks, read back<br>• tab groups and closing duplicates<br>• read later and a Markdown download (content checked)<br>• compare prices on two stores<br>• research with citations<br>• walkthrough PNG |
| Lint, typecheck, prettier, build | clean |
| Earlier gates | Phase 1 static/generic, Phase 2 network gate, Phase 3 and Phase 4 gates re-run inside the Phase 5/6 verifiers |

## Problems found and fixed

1. **Dropdowns were never set.** `SELECT` was a no-op on native `<select>` elements; this dates from
   Phase 1 and was found by the form test. Fixed, with a regression test.
2. **"Go back" failed after agent navigation.** Chrome skips back entries created without a user
   gesture. The agent now falls back to its own page trail on the same site, through the firewall.
3. **Profile form filling was blocked by the firewall's "personal data field" rule.** One narrow rule
   now allows your own saved value of the matching kind, and only that.
4. Cart links named "Cart 1" weren't recognised, and "what's this page about" wasn't matched. Both
   fixed.

## Honest gaps

- The live-site milestone (YouTube play with sound, Flipkart/Amazon search, price filters on real
  cards) is unverified until the Mac run.
- Generic price extraction misses prices drawn as images or split oddly.
- Checkout is cart-only by design.
- The Chrome "debugging" bar shows during a trusted click.
- The monitor scheduler and email alerts are Batch C. Confirm-and-resume is Phase 7.
