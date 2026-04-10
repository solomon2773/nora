# Nora Start Paths

Use this page to pick the fastest open-source route for your situation.

## 1. Self-serve install and launch

Start here if you want to self-host Nora and bring it online on your own infrastructure.

- [README Quick Start](README.md#quick-start)
- [README Configuration](README.md#configuration)
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

- [Public site](https://nora.solomontsao.com)
- [Log in](https://nora.solomontsao.com/login)
- [Create account](https://nora.solomontsao.com/signup)

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

- [Open source / license / PaaS mode](https://nora.solomontsao.com/pricing)
- [README Quick Start](README.md#quick-start)

Best fit:
- you want to confirm commercial usage rights
- you want to run Nora as your own hosted product or internal platform
- you need the difference between `selfhosted` and `paas`
- you want the public repo and public site entry points in one place

## What to include when asking for help

To reduce back-and-forth, include:

- your deployment mode: self-hosted, public browser entry, or self-run PaaS mode
- OS and environment details
- whether you used `setup.sh`, `setup.ps1`, or manual setup
- whether Nora is running in local mode, public-domain proxy mode, or public-domain TLS mode
- whether you are using `PLATFORM_MODE=selfhosted` or `PLATFORM_MODE=paas`
- the step that failed or slowed you down
- relevant logs or screenshots

## Security note

Do **not** post secrets, API keys, `.env` files, or private credentials in Issues or Discussions.

If you are unsure where to start:
- choose [README Quick Start](README.md#quick-start) if you want to self-host
- choose [signup](https://nora.solomontsao.com/signup) or [login](https://nora.solomontsao.com/login) if you want the default public browser entry
- choose [GitHub Discussions](https://github.com/solomon2773/nora/discussions) if you want implementation discussion or setup guidance
- choose [open source / license / PaaS mode](https://nora.solomontsao.com/pricing) if you want the short public explanation of OSS rights and hosted-user-owned deployment mode
