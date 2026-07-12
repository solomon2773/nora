# Nora — Press Kit

Everything a writer, hunter, or partner needs to cover Nora. All assets here are
licensed for editorial use. Questions: open an issue on
[github.com/solomon2773/nora](https://github.com/solomon2773/nora).

## What Nora is (one line)

> Nora is the self-hosted control plane for AI agents — deploy, observe, and operate
> OpenClaw and Hermes agent runtimes on GA Docker and Kubernetes targets. Self-hosted Remote Docker brings
> experimental BYOC placement over pinned SSH plus a private runtime network; the OpenClaw-only NemoClaw profile and Proxmox unprivileged LXC are also
> experimental, with Proxmox still requiring real-hardware smoke before production. Open source,
> Apache-2.0, no vendor lock-in.

## One paragraph

> Nora is an operator-facing platform for running AI agents on your own infrastructure.
> From a single control plane you deploy agent runtimes (OpenClaw or Hermes), manage LLM
> provider keys, configure a 69-entry credential/connectivity catalog, and watch everything live — chat, logs, metrics,
> and a real terminal into each agent. It runs entirely self-hosted via a one-line installer
> on Docker, scales to Kubernetes (k3s/AKS/GKE/EKS), and is fully open source under
> Apache-2.0 — including commercial self-hosting and a built-in PaaS mode for operators
> who want to host Nora for their own customers. Self-hosted Remote Docker BYOC placement and the OpenClaw-only NemoClaw
> sandbox profile are experimental. Proxmox unprivileged LXC placement is also experimental for OpenClaw and prepared Hermes
> images, uses secure API TLS plus pinned SSH, and remains gated on real-hardware smoke before
> production; NemoClaw on Proxmox is blocked.

## Full description

> Most AI-agent tooling is a hosted SaaS you have to trust with your keys, your data, and your
> deployment topology. Nora takes the opposite stance: it is a self-hosted ops platform that
> puts the entire agent lifecycle on infrastructure you control. Operators get one surface to
> deploy and manage runtimes across GA Docker and Kubernetes targets, rotate provider keys
> stored AES-256-GCM encrypted, configure a 69-entry integration catalog (GitHub, Slack, AWS,
> Azure, GCP, Anthropic, OpenAI, and more), and observe each agent through chat, streaming
> logs, live metrics, and a browser terminal. Two runtime families are supported — OpenClaw
> (the broadest operator path) and Hermes — plus an experimental NVIDIA NemoClaw secure-sandbox
> profile for GPU-backed execution. Proxmox unprivileged LXC placement is experimental for
> OpenClaw and prepared Hermes images, with secure API TLS, pinned SSH, and a required
> real-hardware smoke gate before production; NemoClaw on Proxmox remains blocked. Nora is open
> source under Apache-2.0, which means teams can
> read the code before they adopt it, run it commercially on their own hardware, or operate it
> in PaaS mode as the basis for their own product.

## Facts

- **License:** Apache-2.0 (commercial self-hosting allowed)
- **Current release:** [latest GitHub release](https://github.com/solomon2773/nora/releases/latest)
- **Install:** one-line installer (`curl … | bash` / `iwr … | iex`) or Docker Compose
- **Stack:** Node 24 LTS; Express control plane; Next.js operator/admin/marketing UIs;
  PostgreSQL 15; Redis 7 + BullMQ; worker-provisioner with pluggable backend adapters
- **First proof:** built-in deterministic demo provider and demo agent; no external API key or model bill
- **Integrations:** 69 credential/connectivity entries (developer tools, cloud, comms, analytics, data, LLMs); executable tools depend on runtime skills or MCP adapters
- **Security:** AES-256-GCM key encryption, bcrypt password hashing, constant-time auth,
  webhook SSRF guards, JWT sessions
- **Repo:** https://github.com/solomon2773/nora
- **Docs:** https://noradocs.solomontsao.com
- **Site:** https://nora.solomontsao.com
- **Contribute:** https://github.com/solomon2773/nora/blob/master/CONTRIBUTING.md
- **Community:** https://github.com/solomon2773/nora/discussions

## Runtime maturity matrix

Source of truth: `agent-runtime/lib/backendCatalog.ts`. Lead coverage with the GA path.

| Runtime family         | Docker | Remote Docker | Kubernetes | Proxmox unprivileged LXC             |
| ---------------------- | ------ | ------------- | ---------- | ------------------------------------ |
| **OpenClaw** (default) | GA     | Experimental  | GA         | Experimental                         |
| **Hermes**             | GA     | Experimental  | GA         | Experimental (prepared image needed) |

- **GA** — release-ready default path for normal onboarding.
- **Experimental (Remote Docker)** — self-hosted-only registered BYOC host reached over SSH with a pinned host key;
  validate the host from Nora and keep the published runtime ports on a private encrypted network.
- **Experimental (Proxmox)** — requires secure API TLS, pinned SSH, a prepared runtime image
  where applicable, and successful real-hardware smoke before production use.
- **Experimental** — the **NemoClaw** secure-sandbox profile for OpenClaw with NVIDIA-backed
  inference; promising and under active contract validation. It is available on supported Docker,
  Remote Docker, and Kubernetes targets. Hermes does not support NemoClaw, and NemoClaw on Proxmox
  remains blocked.

## Brand assets

In [`logos/`](./logos):

| File                  | Use                                                         |
| --------------------- | ----------------------------------------------------------- |
| `logo-mark.png`       | Square — emblem only, no text (app icon, avatars, favicons) |
| `logo-vertical.png`   | Vertical lockup — emblem + “Nora” title + subtitle          |
| `logo-horizontal.png` | Horizontal lockup — emblem + “Nora” title + subtitle        |
| `og-image.png`        | 1200×630 social / hero card                                 |

All logo variants are cyan (`#8ae6ff`) on transparent for dark backgrounds; on light
backgrounds use a darkened treatment (see `docs/logo/light.png`). `logo-full.png` is kept as
an alias of `logo-vertical.png` for backward compatibility.

Product screenshots (12, operator + admin surfaces) live in
[`../readme-assets/`](../readme-assets) — e.g. `proof-operator-dashboard.png`,
`proof-operator-deploy-flow.png`, `proof-operator-fleet.png`, `proof-admin-agent-hub.png`.

Demo video: [37-second walkthrough (MP4)](https://nora.solomontsao.com/walkthrough.mp4)

## Color palette

| Role                  | Hex       |
| --------------------- | --------- |
| Background (ink/navy) | `#071018` |
| Foreground (light)    | `#eef4fb` |
| Cyan (primary accent) | `#8ae6ff` |
| Warm gold             | `#f2d7a1` |
| Accent orange         | `#ea8d3d` |

Logo mark reads on dark and light backgrounds; on light surfaces use the darkened variant
(`docs/logo/light.png`). Keep clear space around the mark equal to the height of the "N".
