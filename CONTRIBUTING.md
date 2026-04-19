# Contributing to Nora

Thanks for contributing. Nora is an open-source control plane for AI agent operations, and useful contributions are not limited to code. Bug reports, docs fixes, testing improvements, runtime adapters, UX polish, and operational hardening all matter.

By participating in this project, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before You Start

- Read the root [AGENTS.md](./AGENTS.md) and the nearest subtree `AGENTS.md` for the part of the repo you plan to change.
- For install help, setup questions, or product discussion, use [SUPPORT.md](./SUPPORT.md) to choose the right path.
- For substantial feature work or architectural changes, open an issue or discussion before investing in a large PR.
- Keep the public/private repo boundary intact. Public OSS-safe code belongs in this repository; private-only notes and internal material should remain in the paired private repository.

## Good First Contribution Types

- Fix a reproducible bug
- Improve onboarding or self-hosted docs
- Add tests for an existing behavior
- Tighten runtime, worker, or dashboard UX flows
- Improve deployment ergonomics or local verification
- Refine public architecture and support docs to match the product

## Development Workflow

1. Fork the repo and create a focused branch.
2. Make the smallest change that fully solves one problem.
3. Run the most relevant checks for the files you touched.
4. Update docs in the same change when behavior, setup, routes, or architecture changed.
5. Open a pull request with a clear summary and validation notes.

Start with the root [README](./README.md) for setup and common commands. Docker Compose is the default path for local development.

## Repo-Specific Expectations

- Respect the ownership boundaries described in [AGENTS.md](./AGENTS.md).
- Read the local `AGENTS.md` before changing a subtree.
- If your change affects documented behavior, responsibilities, key files, child layout, architecture, or data flow, update the nearest `AGENTS.md` in the same PR.
- If your change affects public setup, deployment, routing, or architecture, update the relevant public docs in the same PR.
- Do not mix unrelated refactors into a feature or bugfix PR.
- Do not commit secrets, `.env` files, credentials, or customer data.
- Do not open public issues for suspected vulnerabilities; follow [SECURITY.md](./SECURITY.md).

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

There is no single command that covers the entire repo. Run the checks that match your scope. Examples:

```bash
docker compose up -d
docker compose logs -f backend-api

cd backend-api && npx jest --no-watchman
cd e2e && npm run smoke:k8s-kind
```

If you could not run a relevant check, say so in the PR.

## Documentation

Public contributor-facing docs currently live at the repo root. Keep them aligned with the actual product:

- [README.md](./README.md) for setup, features, and development entry points
- [SUPPORT.md](./SUPPORT.md) for help and issue-routing
- [SECURITY.md](./SECURITY.md) for private vulnerability reporting
- [architecture.md](./architecture.md) for the public architecture narrative

Treat `/home/projects/nora-private/docs/` as the private docs surface by default. Do not assume `docs/` in this repo is a public shared folder unless the user explicitly asks to promote material into the OSS tree.

## Review Standards

Maintainers may ask you to:

- narrow the scope of a PR
- add or update tests
- move a discussion into the correct issue or docs surface
- split public OSS changes from private-only material
- update stale docs introduced by the change

Contributions that are technically correct but ignore repo boundaries or documentation requirements may be sent back for revision.
