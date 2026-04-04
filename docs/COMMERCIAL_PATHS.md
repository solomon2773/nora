# Nora Commercial Paths

Nora is open source at the core. The commercial motion should sit around rollout speed, support, and deployment scope — not around restricting usage of the repo.

The open-source story comes first:

- Nora is Apache 2.0 licensed
- anyone can self-host it
- anyone can use it commercially
- teams can run it for internal operations, customers, or clients
- the trust anchor should remain the repo, install path, and operator workflow

That OSS-first framing should still feel enterprise-capable. Serious operator teams should be able to evaluate Nora from the public repo without being forced into a sales-led trust process.

## Current paths

### 1. Self-hosted open source

Best for teams that want full infrastructure control.

Start here:

- Repo: `https://github.com/solomon2773/nora`
- Quick start: `README.md#quick-start`
- Install guide: `docs/INSTALL.md`
- Bash install: `https://storage.solomontsao.com/setup.sh`
- PowerShell install: `https://storage.solomontsao.com/setup.ps1`

Best fit:

- you want the clearest trust path
- you want to own the infrastructure and credentials
- you want to validate account creation, provider setup, deployment, chat, logs, and terminal yourself
- you want a self-hosted path that can scale from a small team to an enterprise-capable internal platform

### 2. Rollout help / paid support on your own infrastructure

Best for teams that want the same self-hosted product but a faster path to first value.

Current intake path:

- GitHub Discussions: `https://github.com/solomon2773/nora/discussions`

Best fit:

- setup guidance
- onboarding help
- deployment review
- rollout planning for a self-hosted Nora environment
- support needs tied to a real deployment path

This should be framed as help around the OSS product, not as permission to use it.

### 3. Hosted evaluation / managed PaaS

Best for teams that want less hands-on infrastructure work for the first evaluation cycle.

Current public entry points:

- Hosted app: `https://nora.solomontsao.com`
- Hosted signup: `https://nora.solomontsao.com/signup`
- Deployment / support paths page: `https://nora.solomontsao.com/pricing`

Best fit:

- hosted evaluation
- faster proof without standing up the full stack first
- managed PaaS interest
- early commercial qualification before a deeper deployment conversation

### 4. Enterprise / custom deployment

Best for teams that expect larger-team requirements, more complex infrastructure, or a tailored deployment path.

Current public entry point:

- Deployment / support paths page: `https://nora.solomontsao.com/pricing`

Best fit:

- custom deployment scoping
- enterprise-capable rollout requirements
- private cloud / on-prem environment needs
- AWS, Azure, or GCP rollout planning
- security, identity, networking, or compliance constraints

## Entry points at a glance

| Path | Start here | Best fit signal | Immediate next outcome |
|---|---|---|---|
| Self-hosted open source | `README#Quick Start` + install docs | Team wants full infra control and transparent proof | Account → provider key → first runtime on their own stack |
| Rollout help / paid support | GitHub Discussions | Team wants faster rollout without giving up self-hosting | Scoped help around setup, onboarding, and first-value delivery |
| Hosted evaluation / managed PaaS | Signup + deployment-path page | Team wants less ops overhead for the first evaluation | Faster evaluation start, then managed-path qualification |
| Enterprise / custom deployment | Deployment-path page | Team needs a more tailored environment or rollout scope | Deployment footprint, requirements, and commercial scoping |

## How public commercial scoping should be framed today

Nora does **not** need the repo to lead with invented fixed-plan sales language.

Instead, public messaging should make these points clear:

1. which path to choose — self-hosted, rollout help / paid support, hosted evaluation / managed PaaS, or enterprise/custom
2. what changes scope — infra ownership, rollout depth, support level, deployment complexity, and operator requirements
3. what the next step is — install docs, GitHub Discussions, hosted signup, or deployment-path qualification

A short honest public scoping summary is:

- **Self-hosted OSS:** free under Apache 2.0
- **Rollout help / paid support:** scoped based on setup and support needs
- **Hosted evaluation / managed PaaS:** scoped based on environment and evaluation path
- **Enterprise / custom deployment:** scoped based on deployment footprint and requirements

## Messaging guardrails

Use messaging that is consistent with the product reality:

- lead with the open-source repo and self-hosted proof
- state clearly that Apache 2.0 allows commercial use by anyone
- describe OpenClaw as the strongest supported runtime today
- keep the runtime direction broader than a permanently single-runtime story
- position commercial help around speed, support, managed operations, and deployment scope

Avoid messaging that depends on:

- maintainer-led sales as the repo's main story
- unsupported plan claims, fixed pricing promises, or invented SLAs
- vague enterprise-branding language without operator proof
- implying Nora only becomes credible after a private conversation

## What a strong intake request includes

Whether the conversation starts in GitHub Discussions or after hosted signup, it helps to include:

- which path they want: self-hosted help, hosted evaluation / managed PaaS, or enterprise/custom
- target environment or hosting constraints
- success criteria for the first proof milestone
- expected rollout stage: evaluation, pilot, or production
- known blockers around security, identity, networking, or deployment

## Domain consistency rules

- Use the GitHub repo plus the canonical public installer URLs as the trust anchor for self-hosted evaluation.
- Use `nora.solomontsao.com` for the live app, signup flow, and deployment/commercial path packaging.
- Use GitHub Discussions as the current public rollout-help and paid-support intake.
- Avoid mixing repo-native install CTAs with copy that implies unsupported deployment promises.
