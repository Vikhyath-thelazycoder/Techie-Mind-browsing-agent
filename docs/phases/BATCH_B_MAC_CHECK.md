# Batch B — Mac check (2026-09-29)

This check verifies Batch B (Phase 5 real workflows and Phase 6 skills), which was built in the cloud and merged as `0c04dc1`. It is run on the owner's Mac against real websites and real local models. It is also the **Phase 5 live milestone** and the full regression.

## 1. Sync

- The working tree was clean, so no stash was made.
- Local `main` was at `0a915e6` (the Batch A Mac fixes, already on GitHub): 0 commits ahead, 4 behind.
- `git pull --ff-only origin main` fast-forwarded to **`0c04dc1`**, and `npm ci` completed.

## 2. Tests

| Check | Before the Mac fixes | After |
|---|---|---|
| lint, typecheck, prettier, build | clean | clean |
| Unit (`npm test`) | **430/430** | **437/437** (+7 regression tests, listed in §6) |
| Real Chrome (`npm run test:browser`) | **56/56**, including the side-panel toolbar check that fails in the cloud | **56/56** |
| `verify:phase5` | **8/8** | **8/8** |
| `verify:phase6` | **7/7** | **7/7** |

## 3. Real models

- The Laya selftest is the same as in Batch A; the adapter is unchanged.
- The Laya adapter (`aac6fef/laya-mlx`) and Ollama (`qwen2.5vl:7b`) are both running. The Laya token was passed through `TECHIE_MIND_LAYA_TOKEN`, not on the command line.

| Tier | Batch A | Batch B | Notes |
|---|---|---|---|
| Laya | 97% valid · **31%** accuracy · p50 18 ms | 97% · **31%** · p50 18 ms · p95 443 ms | unchanged |
| Qwen (text) | 100% · **67%** · p50 2.9 s | 100% · **67%** · p50 3.1 s · p95 3.8 s | unchanged |
| Vision | 86% answered · **57%** localization · p50 1.9 s | 86% · **57%** · p50 2.0 s | unchanged |

**Handled by code, with no model call** (the Batch A Qwen miss is now fixed by routing, not by the model):

| Sentence | Code reading | Confidence |
|---|---|---|
| "open the cheapest one" | `pick_item` | 0.9 |
| "scroll down" | `scroll` | 0.9 |
| "go back" | `go_back` | 0.9 |
| "summarize this page" | `summarize` | 0.9 |

- "open the samsung one" still goes to the models, as it should.
- In live runs, "open the cheapest one" logged `modelCalls = 0` on Flipkart and Amazon.

## 4. Live milestone (real websites, `tests/live/milestone-b.spec.ts`, built extension in Chromium)

These runs use a fresh browser profile with the default Chrome autoplay policy and the fake test profile.

**Final run: 26/27 pass.** Each row records pass/fail, the time taken and a screenshot in `evidence/`; the full rows are in `evidence/batch-b-milestone.json`.

| # | Sentence | Result | ms | Evidence | Independent check |
|---|---|---|---|---|---|
| a | play a Kannada song on YouTube | ✅ | 5,242 | batch-b-live-a.png | `/watch` page, **unmuted**, t 2.0 → 5.0 s, user gesture true, trusted click. No "Press Play". Intermittent: see Problem 1 |
| b | search laptops under ₹50,000 on Flipkart | ✅ | 3,260 | batch-b-live-b.png | 16 of 29 cards kept, all at or under ₹50,000, ₹15,990–₹48,990, all with real prices |
| c1 | open the cheapest one | ✅ | 1,681 | batch-b-live-c1.png | Product page (opens in a new tab). The ₹15,990 price is shown on the page. 0 model calls |
| c2 | go back | ✅ | 1,542 | batch-b-live-c2.png | Back on the results. This **crashed before the fix** (§6, fixes 1 and 2) |
| c3 | scroll down | ✅ | 297 | batch-b-live-c3.png | scrollY 576 in the agent's tab |
| d1 | search iPhone 15 on Amazon | ✅ | 24,526 | batch-b-live-d1.png | Searched after waiting out Amazon's empty HTTP 202 page (fix 3). Intermittent (1 in 5 still timed out) |
| d2 | open the cheapest one (Amazon) | ✅ | 8,426 | batch-b-live-d2.png | A real product page (`/dp/`). It clicked a price filter **before the fix** (fix 4). The cheapest result was not an iPhone (Problem 3) |
| e1 | add to cart | ✅ | 7,225 | batch-b-live-e1.png | Verified by Amazon's "added" confirmation |
| e2 | go to cart | ✅ | 2,683 | batch-b-live-e2.png | `/cart` |
| e3 | checkout | ✅ handed over | 31 | batch-b-live-e3.png | HUMAN_REQUIRED. **Nothing was clicked**, and no checkout or sign-in page opened. The agent reported "no checkout control visible", though the cart shows "Proceed to Buy" (Problem 4) |
| f | fill my delivery address (fake profile, demoqa.com) | ✅ | 86 | batch-b-live-f.png | Name, e-mail, mobile and address filled. **Not submitted.** No password, OTP or card values. The e-mail field was blocked by the firewall **before the fix** (fix 5) |
| g | summarize this page (BBC article) | ✅ | 252 | batch-b-live-g.png | Extractive summary of 664 characters from the article |
| r1 | Open Flipkart iPhone *(Batch A)* | ✅ | 3,654 | batch-b-live-r1.png | Searched "iPhone" (query kept), 0 model calls |
| r2 | now click the second product *(Batch A)* | ✅ | 1,570 | batch-b-live-r2.png | Exactly one product tab (no duplicates). Acted on the open site, not Google |
| r3 | iphone 15 *(Batch A)* | ✅ | 1,794 | batch-b-live-r3.png | Same agent tab, searched on Flipkart, 0 model calls, no Google |
| r4 | play a Kannada song *(Batch A)* | ✅ | 5,457 | batch-b-live-r4.png | Query "Kannada song" (article dropped). YouTube played it |

**Tab reuse:** r2 went from 3 tabs to 4, one for the product. r3 stayed in that same tab.

**Earlier-phase live suite (28 tests):**
- Before the fixes: **28/28**.
- After the fixes: **27/28**. The one failure is `P2` playback, from the channel-ranking issue in Problem 1: it handed over honestly, with no false success.

## 5. Skills (real pages)

| # | Sentence | Result | ms | Check |
|---|---|---|---|---|
| s1 | bookmark this page | ✅ | 224 | Bookmark exists in Chrome |
| s2 | show my bookmarks for population | ✅ | 3 | Listed |
| s3 | save this for later | ✅ | 5 | Saved |
| s4 | show my reading list | ✅ | 4 | Listed |
| s5 | save this page | ✅ | 14 | Markdown download, 11,274 characters |
| s6 | export the table as csv (Wikipedia) | ✅ | 9 | CSV of the **real table**: 39 lines, header "Rank, State or Union Territory, Population (2024) …". Before the fix it exported link titles (fixes 6 and 7) |
| s7 | organize my tabs | ✅ | 7 | Tab group "en.wikipedia.org" (2 tabs). A single BBC tab is left ungrouped |
| s8 | take a screenshot walkthrough | ✅ | 99 | PNG 1008×560. The e-mail field, holding a fake address, is **painted black** in the file |
| s9 | compare iPhone 15 prices on Amazon and Flipkart | ✅ | 27,096 | Prices read from both stores. Flipkart: ₹59,900 iPhone 15. Amazon's first card was a sponsored iPhone 17e (Problem 3) |
| s10 | research budget laptops | ❌ | 14,829 | Google served its **CAPTCHA page (`/sorry`)** to the automated test browser (Problem 5) |
| s11 | monitor this product until the price drops below ₹50,000 | ✅ | 64 | Monitor stored: price-below 50,000 INR, every 60 min. Checking arrives with Batch C |

## 6. Code changed on this Mac

Every fix got a failing test with the live sentence first, then the fix, then the affected suites re-run:

| # | Problem (live) | Fix | Test |
|---|---|---|---|
| 1 | "go back" after a product opened in a new tab crashed: **INTERNAL `target.url must be an absolute http(s) URL`**. History redaction turned the long product slug and its "/" into `https://www.flipkart.com[REDACTED_SECRET]` | `privacy/src/sanitize.ts` `safeUrl`: redact each path segment separately, and always return a valid URL (origin fallback) | `privacy.test.ts` "always returns a valid URL…" |
| 2 | In a tab that a click opened, "go back" said "no page to go back to" | `extension/background/host.ts` `adoptTab`: the new tab's page trail starts with the page it was opened from | `host-and-tasks.test.ts`, plus a "go back" step in `context.spec.ts` (real Chrome) |
| 3 | Amazon: "No search field could be found" after 2.2 s. The first document is an empty, quiet HTTP 202 page | `agent-core/src/runner.ts` search refresh waits for the page to **change**, not just to be quiet | `runner.test.ts` "a page that first loads empty…" |
| 4 | "open the cheapest one" clicked the **"Up to ₹31,000" price filter**, verified only because the URL changed | `perception/src/extract.ts`: links back to the listing's own path, and price-only labels, are not items | `extract.test.ts` "price-range filters are not products…" |
| 5 | Form fill: the **name** was planned for the e-mail field (id `userEmail`, placeholder `name@example.com`), and the firewall stopped it | `agent-core/src/forms.ts`: autocomplete first, then `type=email`/`tel`, then wording; camelCase ids are split | new `forms.test.ts` |
| 6 | "export the table as csv" exported link titles | `runner.ts` extract skill: when the request says "table", the page's table wins | `skills.test.ts` |
| 7 | …then it took a small summary box | It takes the largest table (most rows) | same test, with a small table first |

- **New test file:** `tests/live/milestone-b.spec.ts`, the live milestone and regression suite that produces `evidence/batch-b-milestone.json`.
- **Screenshots:** Amazon shows a delivery location guessed from the network ("Bengaluru 5621xx"). It was painted over in the committed screenshots. No real personal data or credentials are in any evidence file. The profile used is fake (Asha Testuser).

## 7. Problems found (for Batch C)

1. **Media result ranking picks a channel sometimes.** In 2 of about 8 YouTube runs, the top-ranked result was a channel ("… Kannada Songs") rather than a video. Once, the channel trailer played ("playing" was verified, but it is not a song). Once, the page had no player, and the agent honestly handed over; that is the live `P2` failure in the post-fix suite run (27/28). Media play should prefer video results over channel or profile links.
2. **Amazon's challenge page** can take longer than the 5 s change window. d1 still failed 1 in 5 after the fix. Wait longer (bounded) when the first document is empty.
3. **Relevance of "cheapest" and "compare".** "cheapest iPhone 15" opened the cheapest *result*, which was another phone (sponsored cards). Compare took a sponsored iPhone 17e from Amazon, and once read "₹0 iOS Lock Screen iPhone 15". Items should be filtered by query relevance, sponsored cards dropped, and ₹0 rejected. Card titles also carry noise ("Add to Compare", "Not deliverable").
4. **Checkout wording.** On Amazon's cart the agent reported "no checkout control visible" instead of recognising **"Proceed to Buy"** as the payment step. It still clicked nothing and handed over. "Proceed to buy/pay" should be classified as checkout, so the handover message is right.
5. **Research needs a non-Google path.** Google shows a CAPTCHA to automated browsers, and your normal Chrome usually won't hit it. The skill should report "a human check is needed", hand over, or use another source, instead of "could not search".
6. **The search step gives no item card on Amazon** ("output none" on d1) when no constraint was asked. That's a minor difference from Flipkart.
7. Carried over from Batch A: Laya 31% and Qwen 67% accuracy, and vision misses small icons.

## 8. Commit

Local branch **`batch-b-mac-check`** holds the fixes, the tests, `tests/live/milestone-b.spec.ts`, this report and the evidence. **Not pushed, not merged.**
