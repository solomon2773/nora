# Nora — Press Kit

Everything a writer, hunter, or partner needs to cover Nora. All assets here are
licensed for editorial use. Questions: open an issue on
[github.com/solomon2773/nora](https://github.com/solomon2773/nora).

## What Nora is (one line)

> Nora is the self-hosted control plane for AI agents — deploy, observe, and operate
> OpenClaw and Hermes agent runtimes on GA Docker and Kubernetes targets. NemoClaw is
> experimental; Proxmox is planned. Open source, Apache-2.0, no vendor lock-in.

## One paragraph

> Nora is an operator-facing platform for running AI agents on your own infrastructure.
> From a single control plane you deploy agent runtimes (OpenClaw or Hermes), manage LLM
> provider keys, wire up 69 integrations, and watch everything live — chat, logs, metrics,
> and a real terminal into each agent. It runs entirely self-hosted via a one-line installer
> on Docker, scales to Kubernetes (k3s/AKS/GKE/EKS), and is fully open source under
> Apache-2.0 — including commercial self-hosting and a built-in PaaS mode for operators
> who want to host Nora for their own customers. The NemoClaw sandbox profile is experimental,
> and Proxmox placement is planned rather than supported in the current release.

## Full description

> Most AI-agent tooling is a hosted SaaS you have to trust with your keys, your data, and your
> deployment topology. Nora takes the opposite stance: it is a self-hosted ops platform that
> puts the entire agent lifecycle on infrastructure you control. Operators get one surface to
> deploy and manage runtimes across GA Docker and Kubernetes targets, rotate provider keys
> stored AES-256-GCM encrypted, connect 69 first-class integrations (GitHub, Slack, AWS,
> Azure, GCP, Anthropic, OpenAI, and more), and observe each agent through chat, streaming
> logs, live metrics, and a browser terminal. Two runtime families are supported — OpenClaw
> (the broadest operator path) and Hermes — plus an experimental NVIDIA NemoClaw secure-sandbox
> profile for GPU-backed execution. Proxmox placement is a planned execution target and remains
> blocked in the current release. Nora is open source under Apache-2.0, which means teams can
> read the code before they adopt it, run it commercially on their own hardware, or operate it
> in PaaS mode as the basis for their own product.

## Facts

- **License:** Apache-2.0 (commercial self-hosting allowed)
- **Current release:** v1.13.0
- **Install:** one-line installer (`curl … | bash` / `iwr … | iex`) or Docker Compose
- **Stack:** Node 24 LTS; Express control plane; Next.js operator/admin/marketing UIs;
  PostgreSQL 15; Redis 7 + BullMQ; worker-provisioner with pluggable backend adapters
- **Integrations:** 69 providers (developer tools, cloud, comms, analytics, data, LLMs)
- **Security:** AES-256-GCM key encryption, bcrypt password hashing, constant-time auth,
  webhook SSRF guards, JWT sessions
- **Repo:** https://github.com/solomon2773/nora
- **Docs:** https://noradocs.solomontsao.com
- **Site:** https://nora.solomontsao.com

## Runtime maturity matrix

Source of truth: `agent-runtime/lib/backendCatalog.ts`. Lead coverage with the GA path.

| Runtime family         | Docker | Kubernetes | Proxmox |
| ---------------------- | ------ | ---------- | ------- |
| **OpenClaw** (default) | GA     | GA         | Roadmap |
| **Hermes**             | GA     | GA         | Roadmap |

- **GA** — release-ready default path for normal onboarding.
- **Roadmap** — planned but not supported in the current release; Proxmox remains
  release-blocked for normal onboarding.
- **Experimental** — the **NemoClaw** secure-sandbox profile (NVIDIA GPU); promising, under
  active contract validation. Applies on top of any runtime/target when the `nemoclaw`
  sandbox profile is selected.

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

Demo video: [60-second walkthrough (MP4)](https://github.com/solomon2773/nora/raw/master/.github/readme-assets/walkthrough.mp4)

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
