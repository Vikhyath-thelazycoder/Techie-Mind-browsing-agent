# Privacy

**Status:** Phase 2 — implemented and tested. Privacy is a local browser boundary: raw page content is detected, redacted or tokenized in the browser; nothing raw is logged, persisted or sent. Visual layers (OCR, faces) are Phase 4.

## Pipeline

```
page (content script)                background (agent)                       network
────────────────────                 ──────────────────                       ───────
scanDocument(): counts only  ──►     sanitizeObservation(): tokens/placeholders
observation (DOM/A11y)       ──►     TokenVault (memory, per task, TTL, single use)
                                     redacted logs · redacted history · audit       ──►  OutboundPrivacyGate ──► fetch
```

## Detection (`packages/privacy/src/detect.ts`)

1. **DOM semantics** — `type=password`, `autocomplete` (cc-number, one-time-code, email, tel, address, postal-code, name), labels / placeholders / names (Aadhaar, PAN, OTP, CVV, UPI, IFSC, account, GSTIN, passport…). A sensitive field is sensitive whatever it holds; search boxes are exempt (they hold the user's own query).
2. **Patterns** — e-mail, Indian and international phones, PAN, IFSC, UPI VPA, voter id, passport and driving licence (with context), JWT, API keys (OpenAI, Anthropic, AWS, GitHub, Google, Slack, HF, GitLab, SendGrid, Stripe), bearer tokens, `password=`/`secret=` assignments, sensitive URL parameters, names and addresses after a cue (label, honorific, greeting, profile header).
3. **Checksums / context** — Aadhaar (12 digits, 2–9 first, **Verhoeff**), cards (**Luhn** + issuer prefix), GSTIN (**base-36 check character**); OTP, CVV, bank account and PIN code only with their context words. A 12-digit number without a valid Verhoeff digit is not an Aadhaar number.
4. **Entropy** — random-looking tokens (≥ 24 chars, ≥ 3 character classes, ≥ 3.6 bits/char), excluding UUIDs, hex digests and slugs.

Overlaps resolve by kind priority, then length. Whole-page rendered text is scanned **inside the page** (`scanDocument`) and only counts leave it.

## Representation (`sanitize.ts`, `vault.ts`)

- Identity/contact/financial values → vault tokens (`EMAIL_001`, `PHONE_001`, `AADHAAR_001`, `PERSON_001`…), resolvable only locally, only in the vault that issued them.
- Passwords, OTPs, CVVs and secrets → `[REDACTED_PASSWORD]` etc. — **never stored**, never re-typed.
- `SanitizedObservation`: no field values at all, redacted names/text/title, path without query/fragment, one finding per item (kind, layer, confidence, token — never the value).
- Vault: memory only, TTL 10 min, ≤ 1,000 entries, single-use resolve, purged at task end, refuses to serialize values.

## Outbound gate (`gate.ts`)

serialize → PII scan → secret scan → sanitization (no raw DOM keys) → schema (`ModelRequest` for models; bodiless site-root GET for probes) → allowlist (models: loopback or configured endpoints; internet: https public hostnames only). Unsafe → **BLOCK** with kinds and counts, never an automatic fix. `gatedFetch` is the only network call in runtime code (verified by a wire guard with a positive control).

## Where values could have leaked, and why they don't

| Channel | Protection |
|---|---|
| Timeline / audit / console | logger applies the privacy engine's redaction, then log masking; events carry counts, never values; page titles are never logged |
| History | page-derived fields redacted, URLs without query strings; the user's own request is kept (needed for Rerun) |
| Storage | agent tab id only; audit events are redacted; no vault persistence |
| Network | privacy gate; only website-resolution probes exist in Phase 2 (site roots) |

## Metrics (plan §52)

Labelled synthetic corpus (`packages/privacy/test/corpus.ts`, 360 samples: 16 kinds × 12 positives + 168 look-alike negatives, all synthetic with valid checksums): precision 1.000, recall 1.000, F1 1.000, false-redaction rate 0.000 (`evidence/privacy-metrics.json`). The corpus is templated; real pages will be harder — see KNOWN_LIMITATIONS.

## References

- Spec §13–17, §55–56, §80; plan §17–20, §40, §52
