# Nora Support Paths

Use this page to pick the fastest support route for your situation.

## 1. Self-serve install and evaluation

Start here if you want to self-host Nora and prove value on your own infrastructure.

- [README Quick Start](README.md#quick-start)
- [README Configuration](README.md#configuration)
- [`infra/setup-tls.sh`](infra/setup-tls.sh)

Best fit:
- you want the cleanest trust path
- you are comfortable operating Docker / Compose
- you want to validate account creation, provider setup, and first agent deployment yourself

## 2. Bugs and product issues

Use GitHub Issues when something appears broken in the product or docs.

- [Open issues](https://github.com/solomon2773/nora/issues)
- [Create a new issue](https://github.com/solomon2773/nora/issues/new)

Best fit:
- reproducible bugs
- documentation errors
- install failures with concrete logs or steps to reproduce

## 3. Rollout help / paid support on your own infrastructure

Use GitHub Discussions if you want the same open-source product but need a faster path to first value on infrastructure you control.

- [Start a support discussion](https://github.com/solomon2773/nora/discussions)
- [Deployment / support paths](https://nora.solomontsao.com/pricing)

This path is for rollout speed and support around the OSS product, not for unlocking usage rights.

Best fit:
- setup guidance
- onboarding help
- deployment review
- rollout planning for a self-hosted Nora environment
- paid-support qualification tied to a real deployment path

## 4. Hosted evaluation / managed PaaS / custom deployment

Use the public deployment paths when self-hosting is not the preferred first step.

- [Deployment / support paths](https://nora.solomontsao.com/pricing)
- [Hosted evaluation signup](https://nora.solomontsao.com/signup)

Best fit:
- you want less self-managed infrastructure work
- you expect a hosted evaluation first
- you want to scope a managed PaaS or custom Nora deployment
- you have larger-team or enterprise-style environment requirements

## What to include when asking for help

To reduce back-and-forth, include:

- your deployment mode: self-hosted, rollout-help / paid-support, hosted evaluation / managed PaaS, or enterprise/custom
- OS and environment details
- whether you used `setup.sh`, `setup.ps1`, or manual setup
- whether Nora is running in local mode, public-domain proxy mode, or public-domain TLS mode
- the step that failed or slowed you down
- relevant logs or screenshots

## Security note

Do **not** post secrets, API keys, `.env` files, or private credentials in Issues or Discussions.

If you are unsure where to start:
- choose [README Quick Start](README.md#quick-start) if you want to self-host
- choose [GitHub Discussions](https://github.com/solomon2773/nora/discussions) if you want rollout help or paid support
- choose [deployment paths](https://nora.solomontsao.com/pricing) or [signup](https://nora.solomontsao.com/signup) if you want a hosted, managed, or custom-deployment path
