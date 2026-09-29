## What this changes

<!-- One or two sentences. Link the issue: Fixes #123 -->

## Why

## How it was tested

- [ ] `npm run lint` and `npm run format:check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:browser` (real Chromium, fixture sites)
- [ ] `npm run test:live`, if navigation, search or a site workflow changed (paste the result)

## Checklist

- [ ] No site-specific selectors or scripts in runtime code
- [ ] Models only propose. Every new action goes through the action firewall and is verified.
- [ ] No raw personal data in logs, tests, fixtures or network traffic
- [ ] Payment, OTP and CAPTCHA still hand over to the human
- [ ] UI changes keep the existing look (design tokens in `apps/extension/src/ui/tokens.css`, screenshots attached)
- [ ] Docs and `CHANGELOG.md` updated
