# Nora Marketing Proof Asset Plan

## Asset
**"Nora public proof pack"**

A small screenshot set captured from the local repo/E2E stack to support homepage copy, README proof points, GitHub social posts, and Discord updates without any live deploy.

## Why this asset
Current positioning is strongest when it shows the product instead of making abstract claims. This proof pack gives us repo-backed evidence for:

- Nora is real and runnable now
- Nora has a public landing + pricing surface
- Nora is honest about the self-hosted-first motion and commercial follow-ons

## Deliverables
1. **Landing proof** — `/`
   - Show hero with: "The open-source control plane for self-hosted OpenClaw agents"
   - Keep the proof strip visible: `18 LLM providers supported`, `60+ tools & integrations catalogued`, `9 channel types supported`, `3 provisioning backends available`

2. **Pricing proof** — `/pricing`
   - Show the commercial-path cards
   - Keep the recommended evaluation path visible
   - Keep the code-backed PaaS envelope section visible lower on the page

## Execution path
No live deploy required.

### Local stack
Use the existing E2E stack and dummy test environment already in the repo:

```bash
cd /root/.openclaw/workspace/projects/nora
NORA_ENV_FILE=.env.test docker compose -f docker-compose.e2e.yml up -d --build
```

Local URL:

```bash
http://127.0.0.1:18080
```

### Capture flow
Fast path using the committed script:

```bash
cd /root/.openclaw/workspace/projects/nora
node e2e/scripts/capture-marketing-proof.mjs
```

That script saves the screenshots into `docs/assets/`.

## Filenames
- `proof-landing-open-source-funnel.png`
- `proof-pricing-commercial-paths.png`

## Suggested captions
- **Landing:** "Nora is the open-source control plane for self-hosted OpenClaw agents."
- **Pricing:** "The public pricing page now leads with self-hosted evaluation and honest commercial follow-on paths."

## Reuse targets
- README proof section
- GitHub repo media
- Discord launch/status posts
- short X/LinkedIn teaser thread
- future homepage screenshot strip

## Definition of done
- local stack boots from the repo
- screenshots are captured locally
- filenames are standardized
- the assets can be reused without needing production access
