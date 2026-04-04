# Nora Repo Proof Pack

Use this document when someone asks a simple question:

> Why should we trust the paid path if Nora is open source?

The answer should come from the repo first.

Nora should earn trust through:

- the self-hosted install path
- the real operator workflow
- concrete screenshots and demo-flow assets
- clear path comparison between OSS, rollout help, hosted evaluation, and enterprise/custom deployment
- honest scoping language that does not outrun the current product

## What someone should be able to prove before any commercial conversation

| What they want to verify | Public proof in repo today | Where to look | What a credible outcome looks like |
|---|---|---|---|
| Nora is really self-hostable | Setup scripts, Docker Compose, env template, install docs | `setup.sh`, `setup.ps1`, `docker-compose.yml`, `.env.example`, `README.md`, `docs/INSTALL.md` | They can see a real install path that does not depend on a sales-led setup |
| The operator entry flow is real | Login and signup surfaces plus backend auth | `frontend-marketing/pages/login.js`, `frontend-marketing/pages/signup.js`, `backend-api/server.js`, `docs/assets/proof-signup-operator-account.png` | They can picture how an operator account is created and enters the product |
| Nora is more than a landing page | Dashboard, deploy, agent, logs, settings, terminal, and runtime-management surfaces | `frontend-dashboard/pages/*`, `frontend-dashboard/components/*`, `docs/assets/proof-operator-dashboard.png`, `docs/assets/proof-operator-fleet.png`, `docs/assets/proof-operator-agent-detail.png` | They can tell the repo contains a real control plane |
| The first demo flow is concrete | Deploy-flow and provider-setup screenshots plus capture scripts | `docs/assets/proof-operator-deploy-flow.png`, `docs/assets/proof-operator-settings-provider-setup.png`, `e2e/scripts/capture-operator-screenshots.mjs`, `e2e/scripts/capture-marketing-proof.mjs` | They can see the path from account -> provider -> runtime -> validation |
| The non-DIY path is honest | Public docs clearly separate self-hosted OSS, rollout help, hosted eval, and enterprise/custom scope | `docs/COMMERCIAL_PATHS.md`, `SUPPORT.md`, `frontend-marketing/pages/pricing.js`, `docs/ADOPTION_CHECKLIST.md` | They can tell what changes when they want help, hosting, or a larger deployment footprint |
| Nora is commercially usable as OSS | Apache 2.0 license and public usage docs | `LICENSE`, `docs/OPEN_SOURCE_USAGE.md`, `docs/assets/proof-usage-rights-apache.png` | They understand they can self-host and use Nora commercially under the license terms |
| Nora is OpenClaw-first today without being boxed in forever | Runtime-direction guidance and repo/product copy | `README.md`, `docs/RUNTIME_DIRECTION.md`, `frontend-marketing/pages/index.js`, `frontend-marketing/pages/pricing.js` | They understand the fastest current proof path without mistaking direction for already-finished multi-runtime support |

## Path comparison

This is the core public comparison table Nora should be able to support today.

| Path | What is already proven publicly | Best-fit signal | Next step |
|---|---|---|---|
| **Self-hosted OSS** | Repo, install docs, setup scripts, Compose flow, screenshots, implementation proof | Team wants full infrastructure ownership and the clearest trust path | Follow `README#Quick Start` or `docs/INSTALL.md` |
| **Rollout help / paid support** | Same OSS product and public proof, plus support intake path | Team wants to self-host but shorten setup, onboarding, or rollout time | Open a GitHub Discussion with target environment and first proof milestone |
| **Hosted eval / managed PaaS** | Public app, signup path, deployment/support page, repo proof assets | Team wants a less DIY first evaluation or a managed operating path | Use signup or the deployment/support path page |
| **Enterprise / custom deployment** | Deployment-footprint direction, public path clarity, OSS proof pack | Team has larger-team, security, networking, identity, or infra-scope requirements | Start with deployment footprint and rollout constraints |

## Screenshot proof map

| Screenshot asset | What it proves | Public narrative it supports |
|---|---|---|
| `docs/assets/proof-landing-open-source-funnel.png` | Nora leads with OSS and self-hosted trust | The repo is the trust anchor |
| `docs/assets/proof-usage-rights-apache.png` | Apache 2.0 and path clarity are shown visually | Teams can use Nora commercially without asking permission |
| `docs/assets/proof-signup-operator-account.png` | The operator account flow exists | This is a real product entry path |
| `docs/assets/proof-operator-dashboard.png` | Nora has a working operator overview | The product is more than marketing copy |
| `docs/assets/proof-operator-fleet.png` | Fleet and validation actions exist | Operators can manage multiple runtimes from one surface |
| `docs/assets/proof-operator-deploy-flow.png` | Deployment flow is visible and concrete | The first runtime path is inspectable before any sales conversation |
| `docs/assets/proof-operator-agent-detail.png` | Logs, validation, and terminal views exist | Nora supports ongoing operations, not just initial setup |
| `docs/assets/proof-operator-settings-provider-setup.png` | Provider setup is part of the current product | The setup path can reach first value without invented steps |

## What makes the paid path credible

The paid path becomes credible when the repo already proves the hard part:

1. Nora can be installed
2. an operator can enter the product
3. a provider can be configured
4. a runtime can be deployed
5. the control-plane workflow can be validated
6. the public docs make it obvious when self-hosting is enough and when rollout help, hosted evaluation, or enterprise/custom scoping makes more sense

That is a stronger trust model than asking someone to believe vague packaging language first.

## Honesty guardrails

Keep the public proof pack credible:

- do not invent fixed pricing plans that are not publicly backed
- do not imply enterprise readiness comes from a sales conversation alone
- do not claim future runtime integrations already exist if they are still directional
- do not imply managed-path guarantees or SLAs that are not documented publicly
- do not hide the self-hosted OSS route behind commercial copy

## Suggested intake details for non-DIY paths

If someone chooses rollout help, hosted evaluation, or enterprise/custom deployment, the first request should ideally include:

- desired path
- target environment
- first proof milestone
- evaluation, pilot, or production stage
- known blockers around security, identity, networking, or deployment

## Related proof docs

- [README](../README.md)
- [Implementation proof](IMPLEMENTATION_PROOF.md)
- [Adoption checklist](ADOPTION_CHECKLIST.md)
- [Commercial paths](COMMERCIAL_PATHS.md)
- [Open-source usage guide](OPEN_SOURCE_USAGE.md)
- [Runtime direction](RUNTIME_DIRECTION.md)
- [Deployment footprints](DEPLOYMENT_FOOTPRINTS.md)
