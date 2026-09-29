# Skills

**Status:** Phase 6 complete (Batch B). All 12 skills of spec §30 are first-class: a manifest (the
`Skill` contract), natural wording and `/skill-id`, an executor on the generic pipeline, and tests.
Manifests: `packages/agent-core/src/skills.ts`. Executors: `#skill…` in
`packages/agent-core/src/runner.ts`. Browser APIs: `apps/extension/src/background/browser-data.ts`.

## How a skill runs

`resolveIntent` recognises the skill (`detectSkill`), the runner routes it (open page or none), and
the skill runs as one goal. That goal uses the same generic steps as every task: navigate, search,
read items, open element and verify. Every click and every typed value passes the 10-check firewall.
Output (items, text, list) appears in the side panel result card and is redacted in history. Skills
never contain site selectors or site scripts.

## Starting a skill

- **In plain words (the main way):** type a sentence in the side panel ("summarize this page",
  "compare iPhone 15 prices on Amazon and Flipkart", "organize my tabs").
- **Slash command:** `/skill-id` plus words (`/deep-research budget laptops`).
- **Voice:** not yet. It arrives with Phase 7.
- The example sentences in Settings come from `SKILL_EXAMPLES` (`custom-skills.ts`). A test checks
  that each one really starts its skill.

## Settings → Skills (added 2026-09-29, on the Mac)

The page follows the reference UI, "Skills & Injected Instructions".

- **Built-in skills.** Every card opens to show:
  - what the skill does and how to say it;
  - its inputs;
  - Security (risk, confirmation, permissions);
  - its Verification checklist and Failure handling.
- **Prompt instructions.** Skills whose result the local model writes (`summarize-page`,
  `deep-research`) show the fixed Privacy rules of the prompt, read-only, and take **your
  instructions**, up to 500 characters.
  - Your instructions are added *after* the fixed rules (`summarizeSystem`).
  - They go only to the local model, through the outbound gate.
  - Code-only skills say they have no prompt; there is no fake edit box.
- **Your own skills (+ New Skill).** A custom skill has a name, trigger sentences (`{input}` captures
  words) and up to 10 steps written as ordinary commands.
  - It is **validated as you type** (`validateCustomSkill`):
    - every step must be a command Techie Mind understands;
    - no step may buy anything or start another custom skill;
    - triggers must not clash with built-in skills or your other skills.
  - It runs **step by step in the background**. Each step runs exactly as if you typed it: same
    firewall, verification and handovers.
  - It stops at the first step that does not complete. A custom skill never adds a capability or
    runs code.
  - It is stored locally under `techieMind.skills` (`SkillsConfig`).

## The 12 skills

| Skill | Say | Strategy | Privacy | Security | Verification | Failure |
|---|---|---|---|---|---|---|
| `summarize-page` | "summarize this page", "what's this page about" | extract main text in the page → redact → local model (extractive without one) | model sees vault tokens only; local model only | read-only | non-empty summary, source shown | no readable text → says so |
| `deep-research` | "research budget laptops [on site]" | search (named site or web) → open top ≤3 results in turn → extract evidence → synthesize with `[n]` citations | page text redacted before any model | clicks through the firewall; back via the agent's own trail | ≥2 sources read; every bullet cited | unreadable sources skipped; <2 → reported, not padded |
| `extract-data` | "extract the data [as csv/json]", "export the table" | generic items (title, price, rating, link) or data tables → optional download | files stay local; URLs without query | read-only; download via the browser | rows read from the page | nothing structured → says so, never invents |
| `compare-prices` | "compare iPhone 15 prices on Amazon and Flipkart" | per store: navigate → search → best-matching priced item → normalize → sort | nothing sent out | navigation only to stores the user named | each price read from that store's page | store without a match → "no matching price", never estimated |
| `fill-form` | "fill my delivery address", "fill this form with my profile" | map fields by meaning (autocomplete, label) → type via vault tokens → verify each | profile AES-GCM encrypted at rest; values only as tokens until the last hop | passwords, OTPs, cards never filled; never submits | each value reads back | no profile → points to Settings → Profile |
| `find-alternatives` | "find alternatives to X under ₹50,000" | search X → drop X itself → apply budget → best rated | — | read-only | options come from the page and satisfy the budget | none within the budget → says so |
| `manage-bookmarks` | "bookmark this page", "show my bookmarks for …", "remove this bookmark" | `chrome.bookmarks` add / search / remove | URL stored without query string | removes only one exact match; several → none removed, listed | read back from the browser | not bookmarked / ambiguous → reported |
| `monitor-page` | "monitor this product until the price drops below ₹X", "watch this page" | Monitor record (price-below or change) + current baseline price | URL without query string; https only | no background fetching yet (Batch C backend) | stored and listed | non-https → refused |
| `organize-tabs` | "organize my tabs", "find/close duplicate tabs" | group by site (`tabGroups`), report duplicates, close extra copies on request | titles/URLs stay local | never closes pinned, active or unique tabs | groups/tabs read back | no tab groups (Firefox) → report instead |
| `read-later` | "save this for later", "show my reading list", "remove this from my reading list" | local list in extension storage | address + title only, no content | — | entry present in the list | — |
| `save-page` | "save this page" | main text → Markdown → browser download (`TechieMind/…`) | personal data and secrets replaced by placeholders | download only | the browser accepted a non-empty file | no readable text → says so |
| `screenshot-walkthrough` | "take a screenshot walkthrough" | redacted capture (Phase 4) + numbered marks on key controls → PNG download + steps | sensitive regions painted before the marks are drawn | read-only | image saved; steps match marks | tab not visible → cannot capture |

## Permissions added in Phase 6

`bookmarks` and `downloads` (Chrome and Firefox), plus `tabGroups` (Chrome only). They're declared in
`apps/extension/scripts/manifest.ts` and checked by `manifest.test.ts`.

## Skill matrix (tests)

- `packages/agent-core/test/skills.test.ts`:
  - **matrix:** 12 valid manifests, and every skill recognised from natural wording and `/id`.
  - **page skills:** extract, walkthrough, save.
  - **multi-source skills:** compare, alternatives, research.
  - **browser data:** bookmarks, monitor, tabs, read later.
- `packages/agent-core/test/workflows.test.ts`: summaries and form filling (Phase 5).
- `tests/browser/skills.spec.ts`: real Chromium with real bookmarks, tab groups and downloads, plus
  compare, research and walkthrough.
- Gates: `node scripts/verify/phase6.mjs all`.

## Not yet

- The monitor-page scheduler, email alerts and the backend are Phase 8 (Batch C).
- deep-research reads at most 3 sources per run (`research.maxSitesPerQuery` caps it further).
- Skills that need confirmation to continue (for example, removing one of several matching
  bookmarks) end with a handover. Confirm-and-resume is Phase 7.
