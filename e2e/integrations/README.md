# Integration smoke harness

A local-only test runner that connects to every provider in the integrations catalog using **your real credentials** and reports which ones pass `provider.test()`. It exists because:

- The Jest suite mocks `fetch`, so it proves our code path but not the live API.
- CI doesn't (and shouldn't) carry real third-party credentials.
- The dashboard's per-integration `Test` button only runs one at a time.

This harness gives you a single command — `npm run smoke:integrations` — that exercises every provider you've populated credentials for and tells you whether each one is currently working against the real API.

## Setup

```bash
cd e2e/integrations
cp .env.providers.example .env.providers
# Edit .env.providers and fill in only the providers you want to test
```

`.env.providers` is gitignored. The example file contains every variable each provider expects — leave the ones you don't want to test blank, and the runner will skip them.

For per-provider details on **where to apply for credentials and which scopes to request**, follow the link in the runner's output to the matching `docs/guides/integrations/<id>.mdx` page.

## Run

```bash
cd e2e
npm run smoke:integrations
```

Sample output:

```
Integration smoke run
=====================
[ 1/68] github           ✓ GET /user → octocat
[ 2/68] slack            ✓ auth.test → ok
[ 3/68] linear           ✓ /viewer → user
[ 4/68] jira             ✗ 401 Unauthorized
[ 5/68] twitter          ⊘ skipped (no credentials)
...
Summary: 56 ✓  4 ✗  8 ⊘
```

Exit code is 0 when all populated providers pass; non-zero on any failure.

## What it actually does

For each catalog entry where `e2e/integrations/.env.providers` declares all required env vars:

1. Builds a `DecryptedIntegration` row (the same shape `integrationsService.testIntegration` would feed `provider.test`).
2. Calls `provider.test(ctx, providerDeps)` directly — same code path the dashboard's `POST /api/agents/:id/integrations/:id/test` route triggers.
3. Captures the result (`success`, `message`, or `error`).

It does **not** hit the Nora backend or write to the database. It's a unit-style invocation of each provider strategy with real credentials, designed to catch upstream API breakage and credential rotation.

## Adding a new provider to the harness

When `.claude/skills/add-integration` registers a new provider, update:

- `.env.providers.example` — add any new env vars the provider needs.
- The harness will pick up the provider automatically since it iterates the catalog.

## Troubleshooting

- **Skipped despite credentials being populated**: check the env var names match exactly (case-sensitive). The example file is the source of truth.
- **"Connection failed" with no detail**: most provider tests preserve the upstream error message. If it's empty, run with `DEBUG=1 npm run smoke:integrations` to dump request/response details.
- **All providers fail with TLS errors**: check your machine's CA certs / proxy. The harness uses Node's built-in fetch.
