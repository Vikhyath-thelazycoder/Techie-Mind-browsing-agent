# Batch C — Mac check (2026-09-29)

MacBook Air (Apple Silicon), real Chrome. Batch C = Phase 7 (handover, voice, languages) + Phase 8
(Supabase monitoring). Merge commit `1f2c67d`; fixes on local branch `batch-c-mac-check`.

## 1. Sync

- Working tree was clean, nothing stashed. `main` fast-forwarded to `1f2c67d`.
- `npm ci && npm run build`: Chrome + Firefox built.

## 2. Quick checks

| Check | Result |
|---|---|
| typecheck (extension + backend) | clean |
| lint | clean |
| unit tests | 447/447 at merge → **461/461** after the fixes below |
| real-Chrome fixture tests | **58/58** |

## 3. Live milestone (real websites)

**34 of 35 pass.** Phase 1 acceptance, corrections, playback (P1, P2), and Batch B milestone a, b+c,
f, g, skills and regressions all pass. **d+e (Amazon)** failed 3 of 3 in the automated browser:
twice Amazon's empty challenge page ("No search field"), once "add to cart" not verified. In the
user's own Chrome, E4 (Amazon search) passed. Kept for Batch D.

## 4. Voice setup

Homebrew, cmake, ffmpeg installed. whisper.cpp built in `~/Developer/whisper.cpp`, `ggml-small`
model, `whisper-server` on `127.0.0.1:8178 --convert`. The curl check transcribed the sample
correctly.

## 5. Supabase setup (no secrets here)

Project `ltrzjjzksecdjfhrvaow`. Migration pushed, `monitor-api` + `monitor-worker` deployed, server
secrets set (Resend key, sender, worker secret), both Vault secrets created. `cron.job`:
`techie-mind-monitor-worker | */5 * * * *`, active. Secrets were typed by the user into a
git-ignored local file and never shown.

## 6. Manual checklist (user, real Chrome)

| Items | Result | Notes |
|---|---|---|
| D1 sign in | ✅ | after the grants fix (below) |
| D2 price monitor | ✅ | after the preview fix (below). Backend read ₹74,900 at 14:50 and 15:00 IST |
| D3 / D4 e-mail | ✅ | price (₹74,900) above target (₹70,000), so correctly no alert. **Send test e-mail** + a Resend check: delivered and received in Gmail (first landed outside the main inbox; alerts go to the monitoring account's own address) |
| D5 pause/resume/cancel/delete | ✅ | |
| D6 Chrome closed | ✅ | check at 15:00 IST ran server-side |
| D7 stock alert | ❌ → fixed | went to Flipkart search |
| A1–A7 handover, pause, stop | ✅ | "Flow is working perfectly" |
| B1–B5 voice | ✅ | spoken reply was only "Done." → fixed |
| C languages | ❌ → fixed | romanized Kannada/Hindi mixes and voice mishearing |
| E1–E4 Batch B regressions | ✅ | |

## 7. Code changed on this Mac

Every fix has a unit test with the user's sentence (`packages/agent-core/test/mac-check-c.test.ts`,
`apps/extension/test/{preview,mac-check-c-ui,mac-check-c-settings}.test.ts`).

| # | Problem | Fix |
|---|---|---|
| 1 | "permission denied for table monitors" | New migration `…_monitoring_grants.sql`: new Supabase projects no longer grant table access |
| 2 | "Ask before acting" blocked every built-in skill ("names no website or query") | Preview handles skills like the runner does |
| 3 | "tell me when this is back in stock" searched Flipkart | Stock-alert wording → monitor skill |
| 4 | "play …" on Flipkart searched Flipkart | A store with product videos is not a media site |
| 5 | "YouTube open maadi Kannada songs play maadu", "neeche scroll down karo", voice "pay 5000 say come" | New word rules; leftover Indian-language words send the request to local Qwen |
| 6 | "how are you" went to Google | Small talk → a chat reply from local Qwen (Laya skipped); built-in reply without a model |
| 7 | Home tiles said "implemented in Phase 6" | Tiles run summarize / extract, prefill research, explain Private Run |
| 8 | "/" showed nothing | "/" skill menu (12 built-in + own skills), arrows + Enter |
| 9 | Speaker said only "Done." | Plain sentence: what was searched/played/opened, or results found |
| 10 | Old "Phase 2/3/6" texts (Privacy, Research, Diagnostics, side-panel Privacy) | Current state |
| 11 | Diagnostics did nothing | Privacy Test (real engine on fake data) + Check Services (Ollama, Laya, Whisper, Supabase) |
| 12 | Profile phone/city fields | +91 country code, autofill-ready form, city → state/country suggestions (built-in list) |
| 13 | No way to test e-mail | **Send test e-mail** (monitor-api `test-email`, own address only, 1 per minute) — deployed |
| 14 | Laya timed out (2.5 s) | Adapter keeps the model warm; first answer 3 s → 34 ms |
| 15 | Confusing no-page message | "No web page is open in this tab. Open the page first…" |
| 16 | Confirmation link opened dead localhost | Setup doc: Site URL + table access notes |
| 17 | Spoken Kannada "ಯುಟ್ಯೂಬ್ ಓಪನ್ ಮಾಡಿ ಕನ್ನಡ ಸಾಂಗ್ಸ್ ಪ್ಲೇ ಮಾಡು" typed the whole sentence into YouTube | Indian-script requests are **translated to English** on the local model first (redacted, ~0.5–1.5 s), unless the word rules already understood them fully. Checked on real Qwen: 10/10 sentences in KN/HI/TA/TE read correctly |

## 8. Problems for Batch D

1. Amazon in the automated browser (challenge page, add-to-cart verification).
2. File upload (attachment button now disabled), demo lab / benchmarks.
3. Unit tests for Batch C code that still has none (resume, voice recorder, backend logic).
4. Laya accuracy is still low (confidences 0.16–0.5 on simple requests); Qwen covers it.
5. Re-test manually: the fixes above, especially languages by voice, "/" menu, test e-mail.
