# Extending Nora integrations

An integration provider owns three things: credential verification, runtime environment mapping, and the catalog metadata shown to operators. Keep those concerns together and cover them with a focused mocked-network test.

## Generate an API-key provider

From the repository root:

```bash
npm run contributor:setup -- --scope integrations
npm run scaffold:integration -- \
  --id acme --name "Acme" \
  --primary-env ACME_API_KEY \
  --test-url https://api.acme.example/v1/me \
  --credentials-url https://acme.example/settings/tokens
```

Use `--dry-run` first if you only want to validate the arguments and see the affected files. The generator refuses to overwrite a provider, test, docs page, or catalog id.

It creates or updates (kebab-case ids become camel-case TypeScript stems, for example `acme-cloud` → `acmeCloud`):

- `providers/<camelId>.ts`: provider strategy with a fail-safe connection result and env mapping
- `catalog/catalog.json`: catalog entry with a secret field and setup metadata
- `services/integrationsService.ts`: provider import and registry entry
- `backend-api/__tests__/providers/<camelId>Provider.test.ts`: mocked success, rejection, identity, and env tests
- `docs/guides/integrations/<id>.mdx`: public guide starter
- `docs/docs.json`: sorted navigation entry for the new guide
- `e2e/integrations/.env.providers.example`: optional real-credential smoke variable

The generated strategy is intentionally a narrow bearer-token baseline. Before opening a PR, adapt the request headers, response parsing, scopes, error messages, configuration fields, and environment mappings to the provider's official API. The validator checks that the generated guide remains present in navigation and rejects orphaned provider pages.

OAuth, service-account, basic-auth, webhook, and user-supplied base-URL providers need provider-specific security and refresh behavior, so the generator does not pretend to automate those. Model those providers on an existing strategy with the same auth type and use `deps.assertSafeUrl` before any request to a configurable URL.

## Provider contract

Every provider implements `Provider` from `types/provider.ts`:

- `id` exactly matches the kebab-case catalog id.
- `authType` matches the catalog entry.
- `test()` returns `{ success: true }` only after the remote service accepts the credential. Catch network/provider errors and return a useful sanitized error.
- `mapToEnv()` maps the primary secret and non-secret config fields to the exact runtime environment names.
- `refreshCredentials()` and `sanitizeForSync()` are optional and should be implemented only when the auth flow needs them.

Do not log credentials, return raw provider bodies containing private data, call the database directly from a provider, or accept a user-configured URL without SSRF validation.

## Catalog checklist

Each catalog entry should include:

- stable kebab-case `id`, operator-facing `name`, category, icon, and precise description
- an accurate `authType` and every required `configFields` entry
- least-privilege credential URL and setup steps/scopes when available
- honest capabilities; do not advertise write or tool support before it exists
- `toolSpecs` only for operations implemented by Nora's integration tool runtime
- accurate MCP metadata (`available: false` is better than an unverified package claim)

## Validate

```bash
npm run contributor:check -- integrations
```

The check validates catalog ids and registry wiring, runs the scaffold generator tests, type-checks the backend, and runs all focused provider tests without real credentials or network access. Real credential smoke coverage is opt-in through `e2e/integrations/.env.providers`.

## Pull request coordination

Call out changes that affect runtime env names, LLM authentication, sync payloads, tool specs, docs navigation, or smoke credentials. Those changes can affect `backend-api/`, `workers/provisioner/`, `agent-runtime/`, the operator dashboard, docs, and e2e even when the provider strategy itself is small.
