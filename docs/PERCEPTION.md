# Perception

**Status:** Phase 1 — DOM (level 1), accessibility (level 2) and semantic grounding (level 3) implemented and validated in real Chromium and on live sites. Local visual perception (level 4) is Phase 4.

## Level 1 — DOM observer (`packages/perception/src/observer.ts`)

Runs in the agent's tab only (content script injected on demand). Collects interactive and semantic elements — links, buttons, inputs, textareas, selects, `[role]`, contenteditable, focusable elements, h1–h3, media — **including open shadow roots**. For each node: tag, role, accessible name, visible text (links/buttons/headings), selected attributes, input type, owning form, current value (editable controls, local only), visibility (`checkVisibility` + non-zero box), interactive/editable flags and page-coordinate bounding box. Derived attributes: `tm:form-role`, `tm:form-action`, `tm:landmark`. Capped at 1,500 nodes, prioritising editable fields and buttons.

Observations never leave the browser (they contain raw page content); Phase 2 adds the privacy engine that produces `SanitizedObservation` for any model.

## Level 2 — Accessibility projection (`accessibility.ts`)

Computed ARIA role (explicit or implicit per HTML-AAM), accessible name (accname order: `aria-labelledby` → `aria-label` → `<label>` → button value/alt → placeholder/title → content), states (disabled, readonly, required, checked, expanded/collapsed, focused, hidden) and nearest landmark. See TECHNICAL_DESIGN decision 15 for why it is computed rather than read from Chrome's native tree.

## Identity and versioning (`registry.ts`)

- **Element ids** (`el-N`) are stable for the lifetime of a document (WeakMap/WeakRef — no leaks).
- **Document id** is minted per document when the script is injected; a navigation produces a new id.
- **DOM version** increments once per batch of structural mutations (MutationObserver).
- **Fingerprint** = FNV-1a of tag|role|name, computed identically at binding time and at execution time.

## Level 3 — Semantic grounding (`packages/agent-core/src/grounding.ts`)

Pure, explainable scoring over an observation — no selectors, no per-site code:

| Grounder | Positive signals | Exclusions / penalties |
|---|---|---|
| Search field | type=search, role searchbox/combobox, search wording in labels/placeholder/name/class, common query names (q, query, search_query…), search form (role or action), banner/search landmark, near top, wide | password/email/tel/number/date…, newsletter/login/coupon/PIN/OTP wording, hidden, disabled |
| Submit control | same form as field, type=submit, search/go label, adjacent to field | clear/voice/camera/lens/filter/back controls excluded |
| Search toggle | button/link with search wording, near top | advanced/voice/image search |
| Results | visible links outside header/nav/footer with query-term overlap (plural-folded), all-terms bonus, descriptive, prominent | fragment/`javascript:` links, labels < 8 chars |

Grounding outputs carry reasons (e.g. `type=search, inside search form, near top`) that are emitted in `TARGET_GROUNDED` events.

## Validated on

Local fixture sites reproducing real patterns (GET form with decoys; script-driven search without `<form>` behind a login overlay; collapsed search; re-mounting field; button-only submit; video site) and live youtube.com and flipkart.com — see phases/PHASE_1_REPORT.md.
