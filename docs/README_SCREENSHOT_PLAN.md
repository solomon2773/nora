# README Screenshot Plan

Goal: keep the README stocked with real product proof, not just landing-page polish.

## Status

The README now includes an initial operator screenshot set alongside the landing / OSS-proof imagery.

Shipped operator assets:

- `docs/assets/proof-operator-dashboard.png`
- `docs/assets/proof-operator-fleet.png`
- `docs/assets/proof-operator-deploy-flow.png`
- `docs/assets/proof-operator-agent-detail.png`
- `docs/assets/proof-operator-settings-provider-setup.png`

These images show the current best-supported OpenClaw path while keeping Nora framed as a broader control plane over time.

## Refresh workflow

1. Start a local Nora stack that is reachable in the browser.
2. Point the screenshot script at that stack if you are not using the default local port.
3. Run:

```bash
cd e2e
npm run capture:operator-readme
```

Useful environment overrides:

- `NORA_SCREENSHOT_BASE_URL` — browser base URL, default `http://127.0.0.1:28080`
- `NORA_SCREENSHOT_DB_CONTAINER` — Postgres container used for deterministic fleet seeding, default `nora-screens-postgres-1`
- `NORA_SCREENSHOT_DIR` — output directory, default `../docs/assets`

## Coverage priorities

1. **Agent list / dashboard**
   - show multiple agents and deployment states
   - make the operator overview legible at a glance

2. **Deploy flow**
   - show the first-run deployment path clearly
   - keep OpenClaw as the first concrete example today

3. **Agent detail view**
   - show the validation surface operators land on after deploy
   - keep logs / terminal / OpenClaw tabs visible even if live runtime capture is limited

4. **Settings / provider setup**
   - show how model/provider configuration fits the onboarding loop

5. **Pricing / support path**
   - show the commercial decision surface alongside Apache 2.0 rights
   - keep managed path and paid-support language visible without making unsupported claims

## Narrative guidance

The README screenshots should communicate:

- Nora is a real operator product, not just a landing page
- OpenClaw is the strongest supported runtime example today
- Nora is not conceptually limited to OpenClaw forever
- the product is self-hostable and practical for technical operators
- Apache 2.0 allows commercial use by anyone
- the pricing/support surface is a real commercial path, not just a legal explainer

## Asset rules

- prefer real screenshots over mockups
- prefer operator-facing UI over purely marketing imagery
- if one runtime is shown, label it as the current best-supported example rather than the permanent only runtime
- keep screenshot filenames descriptive and OSS-first
