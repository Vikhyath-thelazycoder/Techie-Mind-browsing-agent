# Action Firewall

**Status:** Phase 2 — implemented (`packages/security`) and in front of every agent action (element actions, navigation, website checks, recovery navigation). Planners (and, from Phase 3, models) only propose; the firewall decides.

## Checks (in order; the first failure rejects)

| # | Check | Rejects |
|---|---|---|
| 1 | schema | anything that is not a valid `Action` (no script/eval types exist) |
| 2 | task binding | actions of another task |
| 3 | tab binding | actions bound to another tab (cross-tab) |
| 4 | target | unknown element, fingerprint mismatch (swapped identity), hidden target, typing into a non-editable |
| 5 | origin | page origin changed since observation; navigation to a host the user's request did not route to |
| 6 | freshness | replaced document, future (forged) version, observation older than 120 s (runtime clock) |
| 7 | risk | BLOCKED class: non-web navigation, `javascript:` links, raw text into a password field |
| 8 | privacy | typing personal data the user did not provide; unknown/expired vault tokens |
| 9 | injection / provenance | elements carrying instructions aimed at the agent; text to type that is not in the user's request |
| 10 | authorization | HUMAN_REQUIRED (payment, OTP, CAPTCHA, sign-in) → handover; HIGH (destructive, publishing, uploads) at or above `settings.agent.confirmAtRisk` → confirmation handover |

Target/origin/freshness failures are "the page moved on" and feed the recovery ladder (re-observe, re-ground). Every other failure stops the step and hands over with a precise message ("Stopped before … it would authorize a payment"). The content script re-checks binding, fingerprint, visibility and origin at the last hop (defense in depth).

## Risk classes (plan §24)

LOW read/scroll/search · MEDIUM navigation, form typing, add to cart · HIGH delete, publish, send, account changes, upload · HUMAN_REQUIRED payment/OTP/CAPTCHA/sign-in · BLOCKED unsafe. Classified from control semantics (role, accessible name, href, field kind); long link labels are content (result titles) and are judged by their destination only, so a video titled "How to send money" is not a "send" button.

## Evidence

Every decision is an audit event: `ACTION_ALLOWED` (checks passed, risk) or `ACTION_BLOCKED` (check, reasons, handover). Measured cost: ≈ 2 ms per task (P50, fixtures).

## References

- Spec §23–24, §69–71; plan §23–25, §45–46
- Tests: `packages/security/test/firewall.test.ts`, `packages/agent-core/test/runner.test.ts` (in the loop), `tests/browser/adversarial.spec.ts`
