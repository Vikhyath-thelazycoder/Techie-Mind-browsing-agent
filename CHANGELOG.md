# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source project files: MIT license, contributing guide, code of conduct, security policy,
  issue and pull-request templates.

### Removed
- Internal development files from the published repository: phase and batch reports, the
  implementation plan, UI reference screenshots, test evidence and the SIH presentation files.

### Fixed
- The manifest test now allows the `nativeMessaging` permission used by the local helper.

## [0.1.0] - 2026-09-29

First public release, built for Smart India Hackathon 2026 (SIH26171).

### Added
- **Agent core:** plain-language intent, direct navigation to named sites, search, open and play
  results, and follow-ups that reuse the agent's own tab. Every step is verified, and recovery is
  bounded.
- **Security and privacy:** a 10-check action firewall, prompt-injection defence, on-device PII
  detection and redaction, a token vault, an outbound privacy gate, masked logs and a hash-chained
  audit log.
- **Model routing:** code first, then Laya (local, ≈ 34 ms warm), then Qwen 2.5-VL 7B through
  Ollama, then an optional API gateway. Visual fallback runs on demand.
- **Workflows:** shopping with price limits, cart and checkout up to the payment handover, form
  filling from a locally stored profile, and page summaries.
- **12 built-in skills** plus custom skills, started in plain words or with `/skill-id`.
- **Handover and resume**, pause and stop, voice input and output, and Indian-language requests
  (Kannada and others) translated on the device.
- **Price and stock monitoring** on a Supabase backend with e-mail alerts through Resend.
- **Side panel and settings UI:** privacy inspector, diagnostics, the Demo Lab, file attachments
  (PDF, image and text up to 50 MB), and Laya and voice switches.
- Chrome MV3 (116+) and Firefox (142+) builds, unit tests, real-Chromium tests and live-website
  acceptance tests.

[Unreleased]: https://github.com/Vikhyath-thelazycoder/Techie-Mind-browsing-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Vikhyath-thelazycoder/Techie-Mind-browsing-agent/releases/tag/v0.1.0
