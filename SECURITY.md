# Security Policy

Techie Mind is a browser agent that acts on web pages for its user, so security reports matter to
us.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (`main`) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub:
[**Report a vulnerability**](https://github.com/Vikhyath-thelazycoder/Techie-Mind-browsing-agent/security/advisories/new)
(repo → *Security* → *Report a vulnerability*).

Please include:

- what the problem is and what an attacker could do with it
- steps to reproduce: the sentence typed, the page or a minimal HTML file, and the browser version
- any proof of concept, logs or screenshots, **with personal data removed**

We aim to acknowledge a report within 3 working days and to give a fix plan within 14 days. We'll
credit you in the release notes unless you'd rather stay anonymous.

## In scope

- Getting the agent to act without passing the action firewall, or to skip a payment, OTP or
  CAPTCHA handover
- Prompt injection from page content that changes what the agent does
- Personal data leaving the device unredacted: network, logs, model requests or history
- Extension messaging: pages or other extensions driving the background or content script
- The monitoring backend (`apps/backend`): authorization, data exposure, secrets

## Out of scope

- Websites that block or rate-limit automated browsing
- Issues that need a compromised machine or browser profile
- Findings in third-party dependencies with no demonstrated impact on Techie Mind. Report those
  upstream.

## How Techie Mind is secured

See [docs/SECURITY.md](docs/SECURITY.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md),
[docs/ACTION_FIREWALL.md](docs/ACTION_FIREWALL.md) and [docs/PRIVACY.md](docs/PRIVACY.md).
