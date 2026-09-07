# Nora Start Paths

Use this page to pick the fastest open-source route for your situation.

## 1. Self-serve install and launch

Start here if you want to self-host Nora and bring it online on your own infrastructure.

- [README Quick Start](README.md#quick-start)
- [Configuration & environment variables](https://docs.norafleet.ai/configuration/platform-modes)
- [`infra/setup-tls.sh`](infra/setup-tls.sh)

Best fit:

- you want the cleanest trust path
- you are comfortable operating Docker / Compose
- you want to bring account creation, provider setup, and first agent deployment online yourself

## 2. Bugs and product issues

Use GitHub Issues when something appears broken in the product or docs.

- [Open issues](https://github.com/solomon2773/nora/issues)
- [Create a new issue](https://github.com/solomon2773/nora/issues/new)

Best fit:

- reproducible bugs
- documentation errors
- install failures with concrete logs or steps to reproduce

## 3. Public site, login, and signup

Use the default public browser entry when you want to see the reference deployment or create an operator account quickly.

- [Public site](https://norafleet.ai)
- [Log in](https://norafleet.ai/login)
- [Create account](https://norafleet.ai/signup)

Best fit:

- you want the default public browser entry
- you want to check the login or signup flow
- you want a quick public reference deployment before self-hosting

## 4. Discussions and implementation questions

Use GitHub Discussions for setup questions, design discussion, product direction, and implementation tradeoffs around the OSS product.

- [GitHub Discussions](https://github.com/solomon2773/nora/discussions)

Best fit:

- setup guidance
- onboarding questions
- deployment review
- architecture discussion
- runtime or product-direction questions

## 5. Licensing, self-hosting, and PaaS mode

Use the public OSS and licensing page when you need the short version of what Apache 2.0 allows or when you want to run Nora in PaaS mode for your own business.

- [Open source / license / PaaS mode](https://norafleet.ai/pricing)
- [README Quick Start](README.md#quick-start)

Best fit:

- you want to confirm commercial usage rights
- you want to run Nora as your own hosted product or internal platform
- you need the difference between `selfhosted` and `paas`
- you want the public repo and public site entry points in one place

## 6. Security vulnerabilities

Use the private reporting path in [SECURITY.md](SECURITY.md) if you believe you found a vulnerability.

Best fit:

- security bugs with real impact
- unsafe defaults or exposure paths
- credential handling issues
- auth, session, tenant-isolation, or sandbox escape concerns

## What to include when asking for help

To reduce back-and-forth, include:

- your deployment mode: self-hosted, public browser entry, or self-run PaaS mode
- OS and environment details
- whether you used `setup.sh`, `setup.ps1`, or manual setup
- whether Nora is running in local mode, public-domain proxy mode, or public-domain TLS mode
- whether you are using `PLATFORM_MODE=selfhosted` or `PLATFORM_MODE=paas`
- the step that failed or slowed you down
- relevant logs or screenshots

## Response expectations

New external Issues, ready-for-review pull requests, and Discussions receive an automated
acknowledgement so the thread is visibly in Nora's response queue. Draft pull requests enter the queue
and start their clock only when marked ready. A scheduled audit posts a maintainer reminder after
twelve days without a human response and escalates after the fourteen-day target is exceeded.

Maintainers aim to acknowledge complete bug reports, pull requests, and Discussions within fourteen
days. This is a best-effort target, not a support SLA. The automated comment is a queue receipt, not
a human review. If a thread still has no human response after fourteen days, add one polite follow-up
to that thread rather than opening a duplicate.

Reports missing reproduction steps, version details, or sanitized logs may take longer to diagnose. Security reports follow the private process in [SECURITY.md](SECURITY.md) and should never be chased in a public issue.

## Security note

Do **not** post secrets, API keys, `.env` files, or private credentials in Issues or Discussions.
If the problem may be a vulnerability, use [SECURITY.md](SECURITY.md) instead of a public thread.

If you are unsure where to start:

- choose [README Quick Start](README.md#quick-start) if you want to self-host
- choose [signup](https://norafleet.ai/signup) or [login](https://norafleet.ai/login) if you want the default public browser entry
- choose [GitHub Discussions](https://github.com/solomon2773/nora/discussions) if you want implementation discussion or setup guidance
- choose [SECURITY.md](SECURITY.md) if the issue could expose systems, credentials, sessions, or users
- choose [open source / license / PaaS mode](https://norafleet.ai/pricing) if you want the short public explanation of OSS rights and hosted-user-owned deployment mode
