# Nora Marketing Proof Asset Plan

## Asset
**"Nora in 3 Frames" local proof pack**

A small screenshot set captured from the local repo/E2E stack to support homepage copy, README proof points, GitHub social posts, and Discord updates without any live deploy.

## Why this asset
Current positioning is strongest when it shows the product instead of making abstract claims. This proof pack gives us repo-backed evidence for:

- Nora is real and runnable now
- Nora has a public landing + pricing surface
- Nora has an actual operator dashboard for OpenClaw agent management

## Deliverables
1. **Landing proof** — `/`
   - Show hero with: "The open-source control plane for OpenClaw agents"
   - Keep the fact strip visible: `18 LLM providers`, `60+ integrations`, `9 communication channels`, `Open source`

2. **Pricing proof** — `/pricing`
   - Show the plan/limits page
   - Keep the self-hosted vs PaaS explanation visible
   - Reinforces that current public limits are code-backed, not made up

3. **Operator proof** — `/app/agents`
   - Capture the authenticated dashboard shell after creating a local test account
   - This proves Nora is more than a marketing page and has a real operator UX

## Execution path
No live deploy required.

### Local stack
Use the existing E2E stack and dummy test environment already in the repo:

```bash
cd /root/.openclaw/workspace/projects/nora
docker compose -f docker-compose.e2e.yml up -d --build
```

Local URL:

```bash
http://127.0.0.1:18080
```

### Capture flow
1. Open `/` and take the landing proof screenshot.
2. Open `/pricing` and take the pricing proof screenshot.
3. Create a fresh local test account through `/signup`.
4. Sign in and open `/app/agents`.
5. Take the operator proof screenshot.

## Suggested filenames
- `proof-landing-openclaw-control-plane.png`
- `proof-pricing-code-backed-limits.png`
- `proof-dashboard-agent-ops.png`

## Suggested captions
- **Landing:** "Nora is the open-source control plane for OpenClaw agents."
- **Pricing:** "Public limits now reflect the current product code and deployment modes."
- **Dashboard:** "From marketing page to real operator surface: Nora ships with an actual dashboard for agent operations."

## Reuse targets
- homepage proof block or screenshot strip
- README proof section
- GitHub README/media updates
- Discord launch/status posts
- short X/LinkedIn teaser thread

## Definition of done
- 3 screenshots captured locally
- filenames standardized
- one caption written for each screenshot
- ready to drop into homepage, README, or GitHub media without needing production access
