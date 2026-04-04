# Nora Adoption Checklist

Use this checklist to evaluate Nora from an OSS-first point of view.

## Four common adoption paths

| If someone says... | Recommended path | Why |
|---|---|---|
| "We want to run Nora on our own infrastructure." | **Self-host Nora** | The repo, setup scripts, and Docker Compose flow are the clearest trust path. |
| "We want to use Nora commercially inside our business or for customers." | **Apache 2.0 commercial use path** | The license allows commercial use by anyone under the Apache 2.0 terms. |
| "We want rollout help but still want to own the infrastructure." | **Rollout-help path** | GitHub Discussions can shorten the path to first value without changing the OSS trust model. |
| "We want a hosted evaluation or custom deployment conversation." | **Hosted/custom path** | The public proof package should already show the product is real before deployment scoping begins. |

## Self-host checklist

- [ ] Can they use the setup script or Docker Compose flow?
- [ ] Can they create the initial operator account?
- [ ] Can they add one LLM provider key?
- [ ] Can they deploy one runtime and validate chat, logs, terminal, sessions, or tools?
- [ ] Can they see enough operator proof to trust the self-hosted path?

## Apache 2.0 commercial-use checklist

- [ ] Do they understand Nora can be used commercially under Apache 2.0?
- [ ] Do they plan to run it for internal teams, customers, or clients?
- [ ] Do they know they can build service layers, workflows, or packaging around it?
- [ ] Do they understand that operational responsibility stays with whoever runs the deployment?

## Rollout-help checklist

- [ ] Do they want the OSS product, but with less setup friction?
- [ ] Is the target environment already known?
- [ ] Is the first-value milestone defined clearly?
- [ ] Do they know GitHub Discussions is the current public intake path?

## Hosted/custom path checklist

- [ ] Have they already reviewed the repo, install docs, or screenshot proof?
- [ ] Is there a clear reason not to start purely self-hosted?
- [ ] Is the desired deployment footprint named: single-host, Proxmox, private cloud/on-prem, or AWS/Azure/GCP?
- [ ] Are security, identity, networking, or compliance constraints known?
- [ ] Is the first proof milestone concrete enough to scope?

## Positioning checklist

- [ ] Does the public story clearly describe Nora as an open-source AI agent orchestration control panel?
- [ ] Are the five pillars obvious: security built in, easy to use, expandable, self-hostable, and enterprise-capable?
- [ ] Is enterprise-capable grounded in deployment footprint reality rather than vague packaging language?
- [ ] Can someone understand the path from single-host evaluation to Proxmox, private cloud / on-prem, and AWS/Azure/GCP?

## Runtime-direction checklist

- [ ] Are they starting with OpenClaw as the best-supported runtime today?
- [ ] Do the docs avoid implying Nora is permanently OpenClaw-only?
- [ ] Is the product story broad enough for future runtime adapters?
- [ ] Do screenshots and README sections reinforce current proof without closing future direction?

## Supporting docs

- `README.md`
- `docs/PROOF_PACK.md`
- `docs/INSTALL.md`
- `docs/COMMERCIAL_PATHS.md`
- `docs/DEPLOYMENT_FOOTPRINTS.md`
- `docs/RUNTIME_DIRECTION.md`
- `docs/OPEN_SOURCE_USAGE.md`
- `docs/IMPLEMENTATION_PROOF.md`
