# Nora Deployment Footprints

Nora should be understood as an **open-source AI agent orchestration control panel** that can start small and grow into more serious operator environments.

The product should feel credible across this deployment range:

- **single-host self-hosted installs** for first proof, internal tools, and lean operator teams
- **Proxmox-backed environments** for isolated infrastructure and private fleet control
- **private cloud / on-prem clusters** for platform teams that need network, identity, and security ownership
- **AWS, Azure, and GCP** deployments for larger enterprise, multi-environment, or cloud-native rollout paths

OpenClaw is the strongest supported runtime path in Nora today. That should remain the clearest proof path right now. But Nora should also stay friendly to broader runtime integration over time.

## The deployment continuum

### 1. Single-host Nora

Best for:

- first evaluation
- solo operators
- small internal teams
- local or low-complexity self-hosted rollout

Why it matters:

- fastest path to proof
- easiest install story
- strongest repo-to-running-product trust path
- ideal for validating signup, provider setup, first runtime deploy, chat, logs, and terminal

This is the default starting point for most OSS evaluators.

### 2. Proxmox-backed Nora

Best for:

- operators who want stronger isolation boundaries
- homelab or office infrastructure with VM/LXC discipline
- internal platforms that want to scale beyond one machine without jumping fully into public cloud

Why it matters:

- keeps the self-hosted story credible for more serious infrastructure owners
- supports staged expansion of capacity and separation of workloads
- fits Nora’s role as a control layer rather than a one-box-only dashboard

### 3. Private cloud / on-prem Nora

Best for:

- security-conscious internal platform teams
- regulated or network-controlled environments
- organizations that need tighter control over ingress, secrets, identity, and data flow

Why it matters:

- reinforces Nora’s security-first positioning
- supports enterprise-capable operator workflows without giving up self-hosting
- keeps the product aligned with real infrastructure ownership requirements

### 4. AWS / Azure / GCP Nora

Best for:

- cloud-native teams
- multi-environment rollouts
- business units that need standard cloud primitives, IAM models, and network segmentation
- larger pilots or production-oriented operator deployments

Why it matters:

- makes Nora’s enterprise-capable story concrete
- shows Nora can fit into mainstream infrastructure choices
- gives the product a credible path from OSS evaluation to larger deployment scope

## Positioning rule

Nora should be positioned as:

- **security built in**
- **easy to use**
- **expandable**
- **self-hostable**
- **enterprise-capable**
- **OpenClaw-first today**
- **future-runtime-friendly by design**

That is stronger and more durable than either extreme:

- treating Nora as just a small self-hosted toy
- or pretending it is already a fully generalized multi-runtime platform before the product proves that reality

## Runtime stance

### What to say clearly today

- OpenClaw is the strongest supported runtime in Nora today.
- If you want the fastest proof of value, start with OpenClaw.
- Nora already provides the control-plane surface around deployment, credentials, chat, logs, terminal access, and operations.

### What not to imply

- that Nora is permanently useful only with OpenClaw
- that every future runtime integration already exists
- that the platform story depends on inventing unsupported capabilities

### Better framing

Use language like:

- runtime
- runtime adapter
- control plane
- operator workflow
- deployment footprint
- validation surface

That keeps docs and UX extensible while still letting OpenClaw carry the strongest proof path right now.

## Recommended buyer/operator mental model

A good shorthand is:

> Start with Nora on one machine. Prove the operator workflow with OpenClaw. Expand the same control-plane model into Proxmox, private cloud, or AWS/Azure/GCP as requirements grow.

That matches the current product reality and the long-term product direction.

## Related docs

- [README](../README.md)
- [Install guide](INSTALL.md)
- [Open-source usage guide](OPEN_SOURCE_USAGE.md)
- [Adoption checklist](ADOPTION_CHECKLIST.md)
- [Implementation proof](IMPLEMENTATION_PROOF.md)
