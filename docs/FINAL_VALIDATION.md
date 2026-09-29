# Final Validation: Techie Mind (SIH26171)

**Status:** Batch D (Phases 9–10) code complete, 2026-09-29. This report is checked against the
Definition of Done (spec §97). Every item says **how** it was verified:

- **CI**: GitHub Actions on every PR (lint, typecheck, unit tests, build, real-Chromium tests).
- **Mac A / B / C**: the user's real Chrome, real local models and real websites
  (`docs/phases/BATCH_*_MAC_CHECK.md`).
- **Pending (Mac D)**: new in Batch D; to be confirmed with `docs/phases/BATCH_D_CHECKLIST.md`.

## 1. Objective

Close out the product (Phase 9: the UI reflects the actual runtime) and validate it end to end
(Phase 10: tests, security, privacy, real browsers, performance, SIH metrics). Fix every P0/P1 found.

## 2. What was implemented in Batch D

- **Privacy inspector.** Per task: what was read, what sensitive data was found (kinds and counts
  only, kept on the device), injected page text ignored, firewall blocks, which local models saw
  redacted text or screenshots, and exactly what left the device.
- **File upload.**
  - The paperclip attaches a file of up to 10 MB. It stays in memory on the device.
  - "upload it" puts the file into the page's file field, including visually hidden ones.
  - The upload goes through the firewall: user-requested only for that exact file, and the target
    must be a real file field. The field is read back to verify, and nothing is submitted.
- **Tests for code that had none:**
  - Multilingual intents (KN/HI/TA/TE, native and romanized).
  - Pause / stop / resume and expiry.
  - Payment handover.
  - Upload.
  - The monitoring backend's SSRF rules, page reading, transitions and e-mail header safety.

## 3. Files created

- `packages/agent-core/test/batch-cd.test.ts`
- `apps/backend/test/monitor-core.test.ts`
- `docs/FINAL_VALIDATION.md` (this file)
- `docs/phases/BATCH_D_REPORT.md`
- `docs/phases/BATCH_D_CHECKLIST.md`

## 4. Files modified

- **contracts:** `FileAttachment`, `EXECUTE.file`, goal `upload`.
- **perception executor:** `UPLOAD`.
- **security firewall:** file-field rules, attached-file authority.
- **agent-core:** upload command, goal and step.
- **extension:** task service, side panel paperclip + inspector, host, content handler.
- **test fixture:** upload support.
- **root `tsconfig`:** `.ts` imports for the backend tests.

## 5. Agent architecture

Code first: intent (multilingual canonicalization) → route → plan → per-goal observe → ground → bind
(seven fields) → **10-check firewall** → execute → verify → recovery ladder → handover with a
checkpoint (resume). Models (Laya → local Qwen → optional API) only propose; the firewall authorizes.

## 6. Intent resolution

Deterministic resolver for English, plus a Kannada/Hindi/Tamil/Telugu rewrite. The Mac adds local
translation for free-form Indic speech. Only unclear requests are escalated to the local models.

## 7. Browser execution

The content script runs on demand in the agent's tab only. Trusted clicks (media) run only after the
firewall. Uploads use `DataTransfer` into the bound file input.

## 8. DOM / A11y perception

DOM + shadow DOM + accessibility projection with an element registry and a document version.
Hidden file inputs are observed, with `visible: false`.

## 9. Semantic grounding

Query-term ranking. Profile/channel pages and sponsored cards are down-ranked; "cheapest" and
"compare" only consider items that match the query, including numbers.

## 10. Verification and recovery

Every step is verified: URL, cart count, field value, media playing, file present. Recovery is
bounded (retry → refresh → re-ground → alternative → handover), and there is no false success.

## 11. UI integration

Side panel:
- Agent tab: quick actions and the composer with paperclip, language, mic and speaker buttons.
- History.
- Privacy: boundary status and the inspector.
- Handover card: Continue / Approve once / Stop.
- Pause / Stop while a task runs.

Settings: models and voice, privacy, research, profile, skills, monitoring, export, diagnostics.

## 12. Exact tests executed

- `npm run typecheck` (extension + backend), `npm run lint`, `npm run format:check`,
  `npm run build`: this session.
- `npx vitest run`: all unit suites, this session.
- CI on the Batch D PR: the same checks plus `npm run test:browser` (real Chromium).

## 13. Test results

| Suite | Result |
|---|---|
| Unit | **491/491** (33 files), +30 since Batch C (16 agent-core, 11 backend, plus the Mac's own) |
| Real Chromium (CI) | see the Batch D PR; Batch C was 58/58 on the Mac |
| Typecheck / lint / format / build | clean |

## 14. Real-browser results

| Check | Where | Result |
|---|---|---|
| Phase 1–4 acceptance and corrections | Mac A | pass |
| Phase 5 live milestone | Mac B | 26/27 → fixed |
| Phase 7 live milestone | Mac C | **34/35**. Amazon in the *automated* browser failed (challenge page); it passes in the user's own Chrome |

## 15. Definition of Done (spec §97)

| Item | Status | Evidence |
|---|---|---|
| Chrome extension works | ✅ | Mac A/B/C; CI real Chromium |
| Firefox architecture works | ✅ architecture | Firefox build and `web-ext lint` in CI. Limits: no side panel API, tab groups or trusted click (see BROWSER_SUPPORT.md) |
| Current UI preserved | ✅ | reference screenshots; evidence/sidepanel-*.png |
| Settings work | ✅ | Mac C (settings screenshots) |
| Privacy inspector works | 🟡 pending | new in Batch D; Mac D |
| Local privacy filter works | ✅ | privacy unit and corpus metrics (evidence/privacy-metrics.json); Mac B screenshots painted |
| Direct navigation works | ✅ | Mac A (never a Google search for a named site) |
| DOM / A11y perception | ✅ | unit + real Chromium |
| Visual perception works | ✅ | Batch A vision fallback; Mac A bench (`--vision`) |
| Laya works locally | ✅ (low accuracy) | Mac A–C selftest. Confidence 0.16–0.5; Qwen covers it |
| Qwen local reasoning works | ✅ | Mac A–C; model-bench.json |
| API provider works | 🟡 | gateway client + privacy gate unit-tested; not exercised with a real key |
| Action firewall / seven-field binding / stale-DOM protection | ✅ | security unit tests; real Chromium adversarial suite |
| Prompt-injection protection works | ✅ | Phase 2 adversarial suite |
| Verification works | ✅ | every step verified; unit + live |
| Human handover / OTP / CAPTCHA flows | ✅ | Mac C checklist A; resume unit tests |
| Financial stop works | ✅ | Mac B e3; the checkout control is never pressed (unit) |
| All 12 skills exist | ✅ | skills matrix; Mac B s1–s11 (research: fallback added in Batch C) |
| Monitoring works independently / persistent | ✅ | Mac C D1–D6 (Supabase; a check ran server-side with Chrome closed). D7 stock alert fixed on the Mac; re-test in Mac D |
| E-mail notifications work | ✅ | Mac C: a test e-mail sent through the backend was delivered to Gmail; the transition that triggers an alert is unit-tested (no real price drop happened during the check) |
| Voice works | ✅ | Mac C (local Whisper) |
| Multilingual input works | ✅ | Mac C (mixes fixed there; re-test in Mac D) + 10 unit cases |
| Screenshot / PDF workflow works | 🟡 | screenshot walkthrough ✅ (Mac B s8); PDF reading and export not implemented |
| Performance metrics work | ✅ | StageTimings per task; evidence/perf-*.json; model-bench.json |
| SIH evaluation metrics measurable | ✅ | privacy metrics, model bench, live JSON |
| Security / privacy tests pass | ✅ | CI |
| Real-browser validation passes | ✅ with 1 known gap | Mac C 34/35 (Amazon in the automated browser) |

## 16. Performance

Code-only commands take a few ms (Mac B: bookmarks 3 ms, summarize 252 ms). Navigation plus search
takes 1.5–3.7 s on real sites. The local model adds about 0.5–1.5 s when used. Details:
`evidence/model-bench.json`, `evidence/perf-*.json`.

## 17. Security validation

- **Firewall:** 10 checks on every action.
- **Payment, OTP and CAPTCHA** always hand over.
- **Approve once** covers one control on one site.
- **Upload** is authorized only for the attached file, and only into a file field.
- **Monitoring:** SSRF rules (unit-tested), row-level security, and a server-owned recipient
  (header-injection tests).
- **Secrets** are never in the extension or git.

## 18. Known limitations

- Amazon's challenge page can defeat the *automated* test browser, and add-to-cart verification
  there is flaky. It works in the user's own Chrome.
- PDF documents are not read or exported (screenshot walkthrough only).
- Laya's accuracy is low; the local Qwen compensates.
- Free Supabase projects pause after about a week idle; restore from the dashboard.
- Chrome shows a "debugging" bar during trusted clicks.

## 19. External blockers

- **Stores.** Anti-bot measures on large stores apply to automated browsers and cloud servers.
- **Supabase free tier.** Projects pause when idle.
- **Chrome.** The side panel cannot show the microphone prompt (it is granted once in Settings).

## 20. Status

**Implementation complete except PDF.** Remaining for sign-off: the Batch D manual checks
(inspector, upload) on the Mac, and a final regression run there. P0/P1 open: **none known**.
