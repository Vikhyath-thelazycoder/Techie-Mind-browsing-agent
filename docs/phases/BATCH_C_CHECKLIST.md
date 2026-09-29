# Batch C: manual checklist (real Chrome on the Mac)

Load `apps/extension/dist/chrome` after `npm run build` (chrome://extensions → reload). Tick each
item and note anything missing or wrong.

## A. Handover and resume

| # | Do | Expect |
|---|---|---|
| A1 | Open a product page. Say **"checkout"** (or open a cart that shows "Proceed to Buy" and say "checkout") | Card **"Payment is yours"**. Nothing clicked. No Continue button |
| A2 | On a page with a sign-in or OTP step, make the agent reach it (e.g. "add to cart" on a site that asks you to log in) | Card **"Sign-in needed"** / **"One-time code needed"**, with *Why*, *Your part*, "keeps its place until HH:MM" |
| A3 | Do the step yourself in the tab, then click **I've done it — continue** | The task continues at the same step and finishes. The timeline shows "Continuing after your step" |
| A4 | When a click needs your confirmation (a high-risk control, e.g. "delete" / "remove" buttons) | Card **"Confirm this action"** naming the control. **Approve once** → it does that one action and continues |
| A5 | Start "search laptops on Flipkart", then click **Pause** while it runs | Status **Paused**. **Continue** resumes and finishes |
| A6 | Start a task, click **Stop** | Status **Stopped**; nothing more happens in the tab |
| A7 | "research budget laptops" if Google shows a CAPTCHA | It tries DuckDuckGo. If that is blocked too: card **"Human check needed"** → solve it → **Continue** |

## B. Voice

| # | Do | Expect |
|---|---|---|
| B1 | Start whisper.cpp (docs/VOICE.md). Settings → AI & Models → Voice & Audio → **Allow microphone** | "Microphone allowed" |
| B2 | Side panel: click the mic, say "search running shoes on Flipkart", click the mic again | "Recognizing…", then the same plan/run as typed |
| B3 | Click **EN** until **KN**, then say a Kannada request | Recognized in Kannada, and it runs |
| B4 | Turn the **speaker** on and run any task | A short spoken result ("Done." / "ಆಯ್ತು." …) |
| B5 | Engine = Chrome Web Speech **without** the consent box | Mic says consent is needed; nothing is sent |

## C. Languages (type them)

- `ಯೂಟ್ಯೂಬ್‌ನಲ್ಲಿ ಕನ್ನಡ ಹಾಡುಗಳನ್ನು ಪ್ಲೇ ಮಾಡಿ` → YouTube, query "ಕನ್ನಡ ಹಾಡುಗಳು", plays.
- `अमेज़न पर काले जूते ढूंढो` → searches Amazon for "काले जूते".
- `flipkart pe 50000 se kam laptop dhoondo` → Flipkart laptops, price ≤ 50,000 in the output card.
- `सबसे सस्ता वाला खोलो` (on those results) → opens the cheapest matching item.
- `वापस जाओ` / `ಹಿಂದೆ ಹೋಗು` → goes back. `neeche scroll karo` → scrolls.
- `यूट्यूब पर हिंदी गाने चलाओ`, `யூடியூபில் தமிழ் பாடல்கள் ப்ளே பண்ணு`,
  `యూట్యూబ్‌లో తెలుగు పాటలు ప్లే చేయి` → each plays on YouTube.

## D. Monitoring (after docs/MONITORING_BACKEND.md setup)

| # | Do | Expect |
|---|---|---|
| D1 | Settings → Monitoring: URL + anon key → Save → Create account → confirm e-mail → Sign in | "Signed in as …" |
| D2 | On a product page: "monitor this product until the price drops below ₹<a price ABOVE the current one>" | Result card: "Checked every 60 minutes by your monitoring backend…" |
| D3 | Settings → Monitoring → **Check now**, wait ≤ 5 min, Refresh | Last check set, current price shown. **One** e-mail arrives (price is already below target) |
| D4 | Check now again | **No second e-mail** (dedupe) |
| D5 | Pause → Resume → Cancel → Delete | The status changes each time; deleted is gone |
| D6 | Quit Chrome for 15+ min with an active monitor | `cron.job_run_details` / the monitor's "last check" moved on while Chrome was closed |
| D7 | "tell me when this is back in stock" on an out-of-stock item | A stock monitor is created |

## E. Batch B regressions (the fixes)

- "play a Kannada song" several times → a **video** plays, not a channel page.
- Flipkart "iphone 15" → "open the cheapest one" → an iPhone 15, not a case or another model.
- "compare iPhone 15 prices on Amazon and Flipkart" → no sponsored other model, no ₹0.
- Amazon search → no "No search field" failure on the first try (1 in 5 before).
