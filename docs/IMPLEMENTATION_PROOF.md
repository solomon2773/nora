# Nora Open-Source Implementation Proof

This document lists which parts of Nora's OSS story are backed by code or public repo assets in this repository today.

## Proof table

| Claim | What exists in repo today | Where to verify | Why it matters |
|---|---|---|---|
| **Self-hosted install path** | Nora ships repo-native install flows for Bash and PowerShell plus Docker Compose setup. | `setup.sh`, `setup.ps1`, `docker-compose.yml`, `.env.example`, `README.md` | The open-source path is real, not a placeholder. |
| **Operator account flow** | The app includes login and signup surfaces plus backend auth endpoints. | `frontend-marketing/pages/login.js`, `frontend-marketing/pages/signup.js`, `backend-api/server.js` | The product has a real operator entry path, not just a landing page. |
| **Agent operations UI** | Nora includes dashboard, deploy, logs, settings, terminal, sessions, tools, and runtime-management surfaces. | `frontend-dashboard/pages/*`, `frontend-dashboard/components/*`, `frontend-dashboard/components/agents/openclaw/*` | The repo contains a real operator product rather than a brochure-only front end. |
| **Demo-flow proof assets** | The repo already includes operator screenshots and capture scripts for landing, signup, dashboard, deploy flow, agent detail, and provider setup. | `docs/assets/*`, `docs/README_SCREENSHOT_PLAN.md`, `e2e/scripts/capture-operator-screenshots.mjs`, `e2e/scripts/capture-marketing-proof.mjs` | Evaluators can inspect concrete UI proof before any managed conversation. |
| **Deployment-path clarity** | Public docs now distinguish self-hosted OSS, rollout help, and hosted/custom deployment paths without inventing fixed plans. | `docs/COMMERCIAL_PATHS.md`, `docs/INSTALL.md`, `SUPPORT.md`, `frontend-marketing/pages/pricing.js` | The paid path is credible because it is scoped clearly, not because the repo hides the OSS route. |
| **Deployment footprint direction** | Nora is documented as starting with single-host proof while staying credible for Proxmox, private cloud/on-prem, and AWS/Azure/GCP growth. | `README.md`, `docs/DEPLOYMENT_FOOTPRINTS.md`, `docs/OPEN_SOURCE_USAGE.md`, `frontend-marketing/pages/pricing.js` | This makes the enterprise-capable story concrete without claiming unsupported deployment automation. |
| **Runtime direction** | OpenClaw is the strongest supported runtime today, while product language and docs stay open to future runtime integrations. | `README.md`, `frontend-marketing/pages/index.js`, `frontend-marketing/pages/pricing.js`, `docs/DEPLOYMENT_FOOTPRINTS.md` | This keeps the current proof honest without turning Nora into a permanently single-runtime story. |
| **Commercial use by anyone** | The repo is licensed under Apache 2.0 and the supporting docs explain the allowed usage model. | `LICENSE`, `docs/OPEN_SOURCE_USAGE.md`, `frontend-marketing/pages/pricing.js` | Operators can self-host, modify, and use Nora commercially under the Apache 2.0 terms. |

## What the repo should prove first

1. **Installability** — someone can get Nora running from the repo
2. **Operator workflow** — someone can create an account, add a provider, and deploy a runtime
3. **Control-plane value** — chat, logs, terminal, sessions, tools, and monitoring work from one surface
4. **Paid-path credibility** — the repo makes it obvious when to self-host, when to ask for rollout help, and when a hosted/custom path makes sense
5. **Runtime honesty** — OpenClaw is strongest today without being framed as the permanent only-runtime future

## Concrete proof assets for the monetization path

If a buyer or operator asks why the non-DIY path should be trusted, these are the public assets that should answer most of that question:

- `README.md`
- `docs/INSTALL.md`
- `docs/COMMERCIAL_PATHS.md`
- `docs/DEPLOYMENT_FOOTPRINTS.md`
- `docs/OPEN_SOURCE_USAGE.md`
- `docs/ADOPTION_CHECKLIST.md`
- `docs/assets/proof-landing-open-source-funnel.png`
- `docs/assets/proof-signup-operator-account.png`
- `docs/assets/proof-operator-dashboard.png`
- `docs/assets/proof-operator-fleet.png`
- `docs/assets/proof-operator-deploy-flow.png`
- `docs/assets/proof-operator-agent-detail.png`
- `docs/assets/proof-operator-settings-provider-setup.png`

## What should not be the main proof burden

The repo should not need to center proof around:

- maintainer-led sales intake
- vague enterprise packaging language
- gated commercial conversations before trust is earned
- marketing claims that outrun the repo and screenshots
- fixed-plan promises or invented SLAs that are not publicly backed

The strongest proof is still the product itself.
