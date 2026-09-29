# Contributing to Techie Mind

Thanks for helping. This guide covers how to set up, what we expect in a change and how to send
it.

## Ground rules

These rules come from the [specification](docs/TECHIE_MIND_SPEC.md). A change that breaks one of
them won't be merged.

- **Models propose, only the local action firewall authorizes execution.**
- **Code first, models only when needed:** code, then Laya, then local Qwen, then an API. Vision is
  on demand, after the DOM and accessibility tree.
- **No site-specific selectors or scripts in runtime code.** `sites.ts` is routing data only.
- **Explicit sites navigate directly.** "open YouTube" never becomes a Google search.
- **Privacy is local.** Detect and redact before anything leaves the browser. No raw personal data
  in logs, tests or network traffic. Use the fake test profile.
- **Payment, OTP and CAPTCHA always hand over to the human.**
- **Every action is verified.** No fake success, no infinite loops, no `eval()`.
- **Keep the existing UI look and feel.** Use the design tokens in
  [apps/extension/src/ui/tokens.css](apps/extension/src/ui/tokens.css).

## Setup

```bash
npm install
npm run build
npm test
```

You need Node.js 22+ (see `.nvmrc`). For local models, see
[docs/MODEL_ROUTING.md](docs/MODEL_ROUTING.md).

## Making a change

1. Fork the repo and create a branch from `main`, for example `fix/follow-up-tab` or
   `feat/new-skill`.
2. Make your change and add or update tests next to it.
3. Run these checks before you push:

   ```bash
   npm run lint
   npm run format:check
   npm run typecheck
   npm test
   npm run build
   npm run test:browser   # real Chromium, local fixture sites
   ```

   `npm run test:live` uses real websites. Run it when your change touches navigation, search or a
   site workflow, and mention the result in the PR.
4. Update the docs in `docs/` if behaviour changes, and add a line to
   [CHANGELOG.md](CHANGELOG.md) under **Unreleased**.
5. Open a pull request and fill in the template.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: compare prices across three shops
fix(sidepanel): keep the composer visible on short windows
docs: explain the Laya token setup
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`.

## Reporting bugs and ideas

- **Bugs:** open an issue with the bug template. Include the exact sentence you typed, the site,
  the browser version and what happened.
- **Features:** open an issue with the feature template.
- **Security problems:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE)
and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
