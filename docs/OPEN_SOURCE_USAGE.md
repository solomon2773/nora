# Nora Open-Source Usage Guide

Nora is fully open source under **Apache 2.0**.

This repo should lead with that reality:

- you can self-host Nora
- you can modify it
- you can use it commercially
- you can run it for clients, customers, or internal teams
- you can extend it for additional runtime integrations over time

## What Apache 2.0 means in practice

You can:

- run Nora on infrastructure you control
- fork and adapt the codebase for your own workflows
- package Nora into your own internal platform
- host Nora as part of a service business
- build integrations, adapters, deployment tooling, or operational workflows on top of Nora

The repo should not imply that a commercial relationship with the maintainers is required to get value.

It is also reasonable to describe Nora as enterprise-capable, as long as that means the product can support serious self-hosted operator environments rather than serving as vague enterprise packaging language.

## What the public story should center

1. **The public repo and install path**
2. **The self-hosted trust model**
3. **Real operator workflows and screenshots**
4. **OpenClaw as the strongest supported runtime today**
5. **A runtime-friendly direction beyond one permanently locked integration**
6. **A deployment story that scales from single-host through Proxmox, private cloud, and AWS/Azure/GCP**

## Current runtime direction

OpenClaw is the strongest supported runtime path in Nora today.

That should be stated clearly, because it is the best proof path right now.

It should also be stated carefully:

- OpenClaw is the strongest supported runtime **today**
- Nora should not be framed as permanently OpenClaw-only
- docs, copy, and UX should stay compatible with future runtime integrations
- OpenClaw examples should demonstrate current product strength, not permanent product limitation

## Public repo and site guidance

Public-facing docs and pages should emphasize:

- Apache 2.0 licensing
- self-hosting and BYO infrastructure
- repo-native install scripts and Docker Compose setup
- operator workflows like signup, deploy, chat, logs, terminal, and settings
- screenshot proof from the real product
- the core positioning pillars: security built in, easy to use, expandable, self-hostable, and enterprise-capable
- enterprise-capable self-hosting in the practical operator sense
- a clear deployment continuum from single-host to Proxmox, private cloud, and AWS/Azure/GCP
- OpenClaw as the best-supported example today
- runtime direction that remains broader than a single runtime forever

Public-facing docs and pages should avoid centering:

- maintainer-led sales intake as the main headline
- enterprise packaging language as the repo's front door
- claims that require a private conversation before the repo feels trustworthy
- language that treats Nora as permanently useful only with OpenClaw

If enterprise buyers or platform teams are part of the audience, the repo should win them with product proof and operator clarity first, not with a sales-first wrapper.

## If someone asks what they are allowed to do

A short public answer is:

> Nora is Apache 2.0 licensed. You can self-host it, modify it, use it commercially, and offer it as part of your own service or product workflow, subject to the Apache 2.0 terms.

## Repo proof assets

Use these repo-native proof resources when you need to show the OSS story clearly:

- `README.md`
- `docs/PROOF_PACK.md`
- `docs/IMPLEMENTATION_PROOF.md`
- `docs/ADOPTION_CHECKLIST.md`
- `docs/DEPLOYMENT_FOOTPRINTS.md`
- `docs/RUNTIME_DIRECTION.md`
- `docs/assets/proof-landing-open-source-funnel.png`
- `docs/assets/proof-usage-rights-apache.png`
- `docs/assets/proof-signup-operator-account.png`

## Recommended README emphasis

The README should make these points obvious:

- Nora is fully open source
- Apache 2.0 allows commercial use by anyone
- self-hosting is the primary trust path
- OpenClaw is the strongest runtime example today
- Nora should stay open to broader runtime integration over time
- the core positioning pillars should be obvious: security built in, easy to use, expandable, self-hostable, and enterprise-capable
- screenshots should prove operator reality, not just marketing polish
