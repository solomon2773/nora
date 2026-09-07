# Nora documentation source

This directory is the canonical source for **docs.norafleet.ai**, hosted on Mintlify.

Pages are written as MDX. `docs.json` defines navigation, theme, and colors. The schema reference lives at https://mintlify.com/docs.json.

## Local preview

```bash
npm i -g mint
cd docs
mint dev
# preview at http://localhost:3000
```

## Deploying

Mintlify deploys whenever changes land on the configured branch of the connected GitHub repo. Until this directory is connected to the Mintlify project (Mintlify dashboard → Settings → Git), edits here are local-only and do not yet update the published site.

To connect: in the Mintlify dashboard, point the project's Git source at this repo with content path `docs/`.

## Layout

```
docs/
├── docs.json                 # navigation, theme, schema
├── introduction.mdx          # landing page
├── quickstart.mdx
├── self-hosting.mdx
├── concepts/                 # mental-model pages (agents, runtimes, workspaces, …)
├── configuration/            # operator config (env vars, platform modes, …)
├── guides/                   # task-oriented walkthroughs
├── api/                      # REST API reference
└── support/                  # FAQ, troubleshooting, contact
```

## Maintenance rule

When code changes affect documented behavior, update the relevant page in this directory in the same change. Reference pages (env vars, API surface) should be reconciled against the canonical source — `.env.example` for env vars, route handlers for API shape — not freehanded.
