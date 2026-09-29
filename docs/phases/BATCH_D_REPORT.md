# Batch D Report — Phase 9 (Complete product) + Phase 10 (Validation and hardening)

**Status:** code complete, 2026-09-29. The full final report is in
[../FINAL_VALIDATION.md](../FINAL_VALIDATION.md). Manual checks:
[BATCH_D_CHECKLIST.md](BATCH_D_CHECKLIST.md).

## Built

- **Privacy inspector** (Privacy tab), for the last task:
  - what was read;
  - which sensitive data was found (kinds and counts, kept on the device) and which injected text
    was ignored;
  - firewall blocks and which local models saw redacted text or screenshots;
  - exactly what left the device.
- **File upload.**
  - The paperclip attaches a file of up to 10 MB, memory only, with a chip and Remove.
  - "upload it" puts the file into the page's file field, including hidden ones behind styled
    buttons.
  - Firewall: the upload is user-requested only for the exact attached file, and the target must be
    a file field. The field is read back to verify; nothing is submitted.
  - If you continue after a handover, the task keeps its attached file.
- **Tests for Batch C code** (the Mac report's item 3):
  - 16 agent-core tests: languages in 4 scripts plus romanized, price limits, pause / stop / resume
    / expiry, the payment handover and upload;
  - 11 backend tests: SSRF rules and IP classes, reading JSON-LD, meta and text prices, bot walls,
    transitions, e-mail header safety.
- **FINAL_VALIDATION.md**: 20 sections, with every Definition of Done item checked against its
  evidence.

The Mac agent's Batch C work already covered the quick-action cards, "/" skill menu, diagnostics,
Indic translation and the test e-mail.

## Checks

Typecheck (extension + backend), lint, format and build are clean. Unit tests **491/491**.
Real Chromium: CI on the PR.

## Open

- Amazon in the *automated* browser (challenge page, add-to-cart verification). It passes in your
  own Chrome, so it's kept as a known limit.
- PDF reading and export are not implemented.
- Laya's accuracy is low; the local Qwen covers it.
