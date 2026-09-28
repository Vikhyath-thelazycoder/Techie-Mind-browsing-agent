# Batch A — Mac check (2026-09-29)

Batch A (Phase 3 + 4) was built in a cloud session. This checks it on the owner's Mac with the real Laya and Qwen models.

## 1. Sync

- Before syncing, the working tree was clean, so nothing needed stashing. `origin` was already `git@github.com:Vikhyath-thelazycoder/sih26171.git`. Local `main` was at `4d19da6`, 0 commits ahead and 4 behind.
- `git pull --ff-only origin main` fast-forwarded to **`ef7b2b6`**. The Batch A files are present: `packages/models/`, `scripts/laya/laya_adapter.py`, `BATCH_A_REPORT.md`.
- The 2026-09-28 bug fixes B1–B6 are intact after the merge.
- **Found:** `reference/`, including the UI screenshots, is tracked in commit `4d19da6`, which is already on GitHub. That predates this check and nothing was changed here. It needs your decision (see §6).

## 2. Tests

| Check | Result |
|---|---|
| `npm install`, `build`, `lint`, `typecheck` | clean |
| Unit (`npm test`) | **387/387** |
| Real Chrome (`npm run test:browser`) | **44/44**. The test that failed in the cloud passes on the Mac. |

## 3. Local models

**Ollama 0.34.4**
- `qwen2.5vl:7b` is installed.
- Ollama already accepts `chrome-extension://` origins by default: an extension request gets 200, while a random website gets 403.
- So the Ollama app was left running as is. Setting `OLLAMA_ORIGINS` was not needed.

**Laya selftest, before**
- It crashed before `interpret()` ran: `ValueError: Unknown question type None; expected choice, score, or noul`.
- Cause: the adapter sent `{"question", "options"}`, but laya_mlx 0.2 expects `{"type": "choice", "instructions", "criteria"}`.

**Laya's real answer format**
- `{"answers": {"category": {"choice": <label>, "confidence": …, "probabilities": {…}, "action": {"act_probability": p}}}}`
- `act_probability` comes from Laya's act/escalate head (2 outputs). It is P(answer directly).

**Fixes in `scripts/laya/laya_adapter.py`**
1. `raw()` now sends the real question format.
2. `interpret()` reads `choice`, `confidence` and `action.act_probability`, and escalates when `act_probability < 0.5`. It maps description labels back to category ids. Any unknown shape still escalates.
3. The question wording was changed based on measurements over 8 labelled sentences:
   - The original short labels scored 2/8, with confident mistakes (for example "iphone 15" → open_website at 0.99).
   - Richer descriptions as a dict scored 4/8.
   - The same descriptions as a list scored **5/8**, and its mistakes all had confidence below 0.5. The list wording was adopted.

**Laya selftest, after**

| Sentence | Laya | Confidence | Extension (uses only `search`/`page_command` at ≥ 0.75) |
|---|---|---|---|
| iphone 15 | open_website ✗ | 0.35 | escalates to Qwen |
| open the samsung one | open_website ✗ | 0.48 | escalates |
| I want to hear something by Arijit Singh | play_media ✓ | 0.63 | escalates |
| scroll down a bit | page_command ✓ | 0.88 | **uses Laya** |
| Open Flipkart and search phones | search ✓ | 0.20 | escalates |
| open the good one | open_website ✗ | 0.44 | escalates |

- `act_probability` was 1.0 on every sentence, so Laya never escalates by itself. The 0.75 confidence bar is what protects the routing.
- **Adapter:** running from this folder with `nohup`. Log: `~/Library/Logs/techie-mind/laya-adapter.log`. `/health` returns `{"ok":true,"model":"aac6fef/laya-mlx","warm":true,"mode":"laya"}`.
- Requests without the token get 401.

## 4. Benchmark (`evidence/model-bench.json`, 3 runs, M-series 16 GB)

| Tier | Calls | Valid | Accuracy | Cold ms | Warm p50 / p95 ms |
|---|---|---|---|---|---|
| Laya (`aac6fef/laya-mlx`) | 30 | 100% | **30%** (3/10). 0% escalated by Laya itself; 9/10 fall under the 0.75 bar. | 182 | **19 / 33** |
| Qwen (`qwen2.5vl:7b`, text) | 18 | 100% | **33%** | 3,034 | 2,966 / 4,245 |
| Vision (`qwen2.5vl:7b`, 1008×756, 7 targets) | 21 | 86% answered | **57%** localization, mean IoU 0.42 | 2,113 | 3,346 / 5,789 |

**Laya misses** (7/10):
- "iphone 15", "budget phones under 10000", "open the samsung one", "the one with 256 GB", "put on some lofi beats", "make the text bigger" and "hmm not sure" were all answered `open_website`.
- Each one had confidence between 0.19 and 0.54, so the extension escalates them rather than using them.

**Qwen misses:**
- "open the samsung one" → `open_result` with no element chosen (expected element el-4).
- "the cheapest one please" → a search for "cheapest phone" (expected el-6).
- "open the google phone" → `open_result` with no element (expected el-5).
- "I want to hear something by Arijit Singh" → abstained ("page is about phones").

**Vision misses:**
- The shopping-cart icon: the box was outside the image.
- The search icon: box 866,27,888,49.
- The heart icon: box 928,28,948,50.
- All three are small icons, about 20 px.

## 4b. Fixes after the side-panel test (2026-09-29)

| Seen in the side panel | Cause | Fix |
|---|---|---|
| "now open the samsung one" → "Could not understand what to open or do · deterministic · 0 model calls" | "Ask before acting" shows a **code-only plan preview**. For an unsure request that preview reported a problem and **disabled Run**, so the models were never reached. | When code is unsure, the preview says "Ask the local AI what you mean…" and keeps Run enabled (`task-client.ts`, `activity.tsx`, new `preview.test.ts`). A request pasted inside quotes is read without them. With quotes it had been misread as a website called "samsung one". |
| "laya: unavailable — Laya adapter rejected the token" | The token file has no final newline, so `cat` in zsh prints a trailing `%`. The pasted token then does not match. Verified: the file's token gets 200 and token+`%` gets 401. | Copy it with `pbcopy < ~/.config/techie-mind/laya.token`. The Settings hint now says so. |
| "qwen: invalid in 6012 ms — answer is not the required JSON" for "iphone 15" | (a) A plain query was sent to the models at all: code gave bare queries 0.5 confidence. (b) The exact invalid answer could not be reproduced here; the same request answered valid in 4 s. | (a) Short name-like queries ("iphone 15", "samsung phones") are now code-confident: no model call, so they run instantly. Sentences, pronouns, "the … one" and imperative verbs still go to the models. (b) "Invalid" now records which check failed (structure only, never content). The next occurrence will say why. |
| Qwen often did not pick the element (33% in the benchmark) | Seen in Qwen's raw output: it chose the right element but labelled the answer `"kind":"intent"` with `action: open_result` and `elementId`. The parser dropped the element. | An open/play answer that names an element is read as an element pick. It is still checked against the elements shown, and still authorized by the firewall. **Qwen accuracy went from 33% to 67%** on the re-run benchmark. |

Re-run numbers: unit 393/393 (+6), real Chrome 44/44. The model browser test now also checks that a plain follow-up makes 0 model calls. Benchmark re-run results:
- Laya 31%, p50 18 ms.
- Qwen **67%**, p50 2.9 s. Remaining misses: "the cheapest one please", which needs a price comparison, and "Arijit Singh" on a phones page, where Qwen abstains.
- Vision unchanged at 57%.

## 5. Code changed on this Mac

- `scripts/laya/laya_adapter.py`: the question format, `interpret()`, the wording, and the selftest samples.
- After the side-panel test:
  - `packages/models/src/parse.ts` and `intelligence.ts`: element picks inside intent answers, and invalid-answer reasons.
  - `packages/agent-core/src/intent.ts`: plain queries are code-confident, and quotes around a request are stripped.
  - `apps/extension/src/sidepanel/task-client.ts` and `activity.tsx`: the unsure preview.
  - `apps/extension/src/settings/SettingsApp.tsx`: the token hint.
  - Tests: `packages/models/test/models.test.ts`, `packages/agent-core/test/models.test.ts`, `apps/extension/test/preview.test.ts`, `tests/browser/models.spec.ts`.
- Test runs rewrote some files under `evidence/` (screenshots, perf JSON). Those are regenerated artifacts, not code.
- Not committed yet: waiting for your OK to commit to a local branch `batch-a-mac-fixes`, with no push.

## 6. Problems found

1. **Laya adapter was broken with real Laya.** It used the wrong question format, so every call failed and every request went to Qwen. Fixed.
2. **Laya is weak at this task.** It scores 30% and leans toward "open website". It is safe, because the wrong answers are low-confidence and escalate. But it saves a Qwen call only for clear page commands.
   - Options: keep it for page commands only; try other question designs, such as one yes/no (`noul`) question per category; or turn it off. Turning it off would save about 20 ms per unsure request.
3. **Qwen picks the element poorly.** It scores 33%. For "the samsung one" it answers `open_result` with no element.
   - Likely causes: the prompt, or the list of elements it is shown.
   - This needs work before the Phase 5 milestone. Right now these follow-ups end as "ask the user" or fall back to code ranking.
   - Qwen also takes 3–4 s per call.
4. **Vision misses small icons.** Localization is 57%, and all misses are icons around 20 px. Higher-resolution crops, or asking for the element list around the icon, may help.
5. **A stale Laya adapter was running from another folder** (`~/Developer/techie-mind-main`, started 2026-09-28 23:26) on port 8765, with the old code. It was stopped with SIGTERM so that the fixed one could run.
6. **`reference/` is on GitHub** in commit `4d19da6`, against the "keep reference/ out" rule. Removing it needs a new commit, and a history rewrite if it must disappear completely. That is your call.
