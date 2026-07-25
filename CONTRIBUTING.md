# Contributing to Nora

Thanks for contributing. Nora is the self-hosted AI agent ops platform, and useful contributions are not limited to code. Bug reports, docs fixes, testing improvements, runtime adapters, UX polish, and operational hardening all matter.

By participating in this project, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before You Start

- Read [CLAUDE.md](./CLAUDE.md) for the public architecture map, shared-code warnings, and service boundaries.
- For install help, setup questions, or product discussion, use [SUPPORT.md](./SUPPORT.md) to choose the right path.
- For substantial feature work or architectural changes, open an issue or discussion before investing in a large PR.
- Do not commit secrets, customer data, local notes, or environment-specific operational material.

Nora is Apache-2.0 licensed. Unless you explicitly state otherwise, a contribution you intentionally submit for inclusion in Nora is provided under that same license. Nora does not currently require a separate contributor license agreement or DCO sign-off.

## Good First Contribution Types

Looking for a concrete starting point? Browse the [`good first issue`](https://github.com/solomon2773/nora/labels/good%20first%20issue) label — small, self-contained tasks with a clear done-state. More broadly, valuable contributions include:

- Fix a reproducible bug
- Improve onboarding or self-hosted docs
- Add tests for an existing behavior
- Tighten runtime, worker, or dashboard UX flows
- Improve deployment ergonomics or local verification
- Refine public architecture and support docs to match the product

## Development Workflow

1. Fork the repo and create a focused branch.
2. Install the repository dependencies with `npm run contributor:setup`. Add `-- --scope backend-api` (or another scope listed by `npm run contributor:setup -- --help`) when you only need one subsystem.
3. Make the smallest change that fully solves one problem.
4. Run `npm run contributor:check`; it detects changed subsystems. Use `npm run contributor:check -- backend-api` for an explicit target or `-- all` before a broad PR.
5. Update docs in the same change when behavior, setup, routes, or architecture changed.
6. Open a pull request with a clear summary and validation notes.

Start with the root [README](./README.md) for setup and common commands. Docker Compose is the default path for local development.

You can also open the repository in a dev container. It includes Node 24 and Docker access and runs the same contributor bootstrap command when it is created.

## Repo-Specific Expectations

- Respect the service boundaries and shared-code warnings in [CLAUDE.md](./CLAUDE.md), especially `agent-runtime/` and `workers/provisioner/backends/`, which affect multiple services.
- Keep changes within one subsystem where practical and call out every affected subsystem in the pull request.
- If your change affects documented behavior, setup, routes, architecture, or data flow, update the corresponding tracked public docs in the same PR.
- If your change affects public setup, deployment, routing, or architecture, update the relevant public docs in the same PR.
- Do not mix unrelated refactors into a feature or bugfix PR.
- Do not commit secrets, `.env` files, credentials, or customer data.
- Do not open public issues for suspected vulnerabilities; follow [SECURITY.md](./SECURITY.md).

## Extension Workflows

Integration providers and deploy-target adapters have public scaffolders:

```bash
# API-key integration provider, catalog entry, focused test, docs stub, and smoke env entry
npm run scaffold:integration -- \
  --id acme --name "Acme" --primary-env ACME_API_KEY \
  --test-url https://api.acme.example/v1/me

# Provisioner adapter class and contract-test starter
npm run scaffold:backend -- --id acme-cloud --name "Acme Cloud"
```

Read [the integration extension guide](./backend-api/integrations/README.md) or [the backend adapter guide](./workers/provisioner/backends/README.md) before running a scaffolder. Both commands refuse to overwrite existing files. A generated backend adapter is deliberately unregistered and fails closed until its lifecycle implementation and cross-subsystem wiring are complete.

## Issues, Discussions, and Pull Requests

Use GitHub Issues for:

- reproducible bugs
- documentation errors
- install failures with concrete steps and logs

Use GitHub Discussions for:

- setup questions
- architecture tradeoffs
- product direction
- implementation discussion before coding

When opening a pull request:

- describe the user-visible or maintainer-visible change
- list the commands, tests, or manual checks you ran
- call out follow-up work or known limitations
- keep screenshots or proof focused on the changed behavior

The repo already includes a [pull request template](./.github/pull_request_template.md). Use it.

## Validation

Use the contributor runner for fast, repeatable validation:

```bash
npm run contributor:check                    # infer scopes from changed files
npm run contributor:check -- integrations    # provider catalog + provider tests
npm run contributor:check -- backend-adapters
npm run contributor:check -- all             # all local unit/type checks
```

Live and infrastructure checks remain explicit because they need Docker, credentials, or a running stack:

```bash
docker compose up -d
docker compose logs -f backend-api
cd e2e && npm run smoke:k8s-kind
```

If you could not run a relevant check, say so in the PR.

## Documentation

Public contributor-facing docs currently live at the repo root. Keep them aligned with the actual product:

- [README.md](./README.md) for setup, features, and development entry points
- [SUPPORT.md](./SUPPORT.md) for help and issue-routing
- [SECURITY.md](./SECURITY.md) for private vulnerability reporting
- [docs/concepts/architecture.mdx](./docs/concepts/architecture.mdx) for the public architecture narrative

## Review Standards

Nora is currently maintainer-led, so review capacity can vary. External Issues, ready-for-review pull
requests, and Discussions receive an automated queue acknowledgement. Draft pull requests enter the
response queue and start their clock only when marked ready. A scheduled check reminds the maintainer
at twelve days without a human response and escalates when the fourteen-day target is exceeded.
Maintainers aim to acknowledge a complete thread within fourteen days; this is a response target,
not a guaranteed SLA, and the automated queue receipt is not a human review. If there has been no
human response after fourteen days, one polite ping on the original thread is welcome. Please do not
open duplicates to get attention.

PRs move fastest when they are small, linked to an issue for substantial changes, include proof, and pass the targeted contributor check. Draft PRs are welcome for early architectural feedback; mark them ready only when the description and validation notes are complete.

Maintainers may ask you to:

- narrow the scope of a PR
- add or update tests
- move a discussion into the correct issue or docs surface
- split unrelated code, docs, or product changes into focused PRs
- update stale docs introduced by the change

Contributions that are technically correct but ignore repo boundaries or documentation requirements may be sent back for revision.
