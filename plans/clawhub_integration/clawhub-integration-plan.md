# ClawHub Integration Plan

This plan breaks the ClawHub feature into small, testable phases. Each phase is designed so a backend worker can define the API contract first, then a frontend worker can build against it. Earlier phases unblock later ones. Phase 0 is required scaffolding.

All file references use the current TypeScript extensions (`.ts` / `.tsx`). The full API contract and persistence shape are defined in `clawhub_integrations_manifest.md` in this directory — this plan references that document as the source of truth for shapes, error codes, and field names.

---

## Phase 0: Schema And Routing Scaffolding
### Goal
Create the minimal backend and frontend plumbing needed so later phases can add ClawHub behavior without blocking on missing tables, routes, or shared types.

### Backend (Worker 1)
Files to create/modify:
- `backend-api/db_schema.sql`
- `backend-api/server.ts`
- `backend-api/redisQueue.ts`
- `backend-api/package.json`
- `backend-api/routes/clawhub.ts` — stub router only, no business logic

Tasks:
- Apply the DB migration: `ALTER TABLE agents ADD COLUMN clawhub_skills JSONB DEFAULT '[]';`
- Register `/api/clawhub` in `server.ts` pointing at the stub router so the route exists and the app compiles
- Add the `clawhubInstalls` BullMQ queue definition in `redisQueue.ts` alongside the existing `deployments` queue — queue plumbing only, no job handlers yet
- Add the YAML frontmatter parser dependency to `backend-api/package.json`

Do NOT touch:
- ClawHub catalog fetch or parse logic
- Install job worker behavior
- Any agent ownership or runtime validation

### Frontend (Worker 2)
Files to create/modify:
- `frontend-dashboard/pages/agents/[id].tsx` — add the `ClawHub` tab entry to the tab list; render a placeholder panel for now
- `frontend-dashboard/components/agents/OpenClawTab.tsx` — add `ClawHub` to the subtab list
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx` — stub component, renders a "Coming soon" placeholder

Do NOT touch:
- Search result rendering
- Detail panels
- Selection or install flows
- Any install polling logic

### Acceptance Criteria
- [ ] DB: `agents.clawhub_skills JSONB DEFAULT '[]'` exists on the agents table and the column is queryable.
- [ ] Backend: the `/api/clawhub` route is mounted and returns a non-404 response (even if empty).
- [ ] Backend: the `clawhubInstalls` BullMQ queue is defined in `redisQueue.ts` without crashing the worker on startup.
- [ ] Frontend: the agent detail page renders a visible `ClawHub` tab that loads without a runtime error.
- [ ] End-to-end: the app starts with no missing-route or missing-column errors related to the ClawHub scaffolding.

### ✅ Gate
Do not proceed to Phase 1 until all acceptance criteria pass and both workers have reported completion.

---

## Phase 1: ClawHub Catalog Discovery
### Goal
Allow Nora to proxy ClawHub browse, search, and detail requests so the UI can render a real catalog without talking to ClawHub directly.

### Backend (Worker 1)
Files to create/modify:
- `backend-api/clawhubClient.ts` — all fetch, SKILL.md download, frontmatter parse, and normalization logic
- `backend-api/routes/clawhub.ts` — thin route handlers for browse, search, detail
- `backend-api/__tests__/clawhub.test.ts`

API contract (exact shapes — see manifest §Shared API Contract for full detail):

`GET /api/clawhub/skills?limit=20&cursor=<cursor>`
- `200`
  ```json
  { "skills": [{ "slug": "github", "name": "GitHub", "description": "...", "downloads": 0, "stars": 0, "updatedAt": "2026-04-01T12:00:00Z" }], "cursor": null }
  ```
- `502`
  ```json
  { "error": "clawhub_unavailable", "message": "Could not reach ClawHub registry." }
  ```

`GET /api/clawhub/skills/search?q=<query>&limit=20`
- `200` — same shape as browse
- `400`
  ```json
  { "error": "missing_query", "message": "q is required." }
  ```
- `502`
  ```json
  { "error": "clawhub_unavailable", "message": "Could not reach ClawHub registry." }
  ```

`GET /api/clawhub/skills/:slug`
- `200`
  ```json
  {
    "slug": "github",
    "name": "GitHub",
    "description": "...",
    "downloads": 0,
    "stars": 0,
    "updatedAt": "2026-04-01T12:00:00Z",
    "readme": "# GitHub Skill\n...",
    "requirements": {
      "bins": ["gh"],
      "env": ["GITHUB_TOKEN"],
      "config": [],
      "install": [{ "kind": "node", "name": "@github/gh-cli" }]
    }
  }
  ```
  Note: `requirements` is `null` when SKILL.md has no `metadata.openclaw` block. When non-null, all four array fields are always present (may be empty). The `kind` field is the normalized form of `package` from SKILL.md frontmatter.
- `404`
  ```json
  { "error": "skill_not_found", "message": "No skill found with slug: github" }
  ```

Do NOT touch:
- Deploy-time persistence
- Install or job polling routes
- Frontend install flow

### Frontend (Worker 2)
Files to create/modify:
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx` — browse/search state, coordinates child components
- `frontend-dashboard/components/agents/openclaw/SkillSearchBar.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillGrid.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillCard.tsx`
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.tsx` — read-only detail view; renders readme and requirements; no install action yet

Depends on:
- `GET /api/clawhub/skills`
- `GET /api/clawhub/skills/search`
- `GET /api/clawhub/skills/:slug`

Implementation notes:
- `SkillDetailPanel` is created in this phase as a read-only panel — it shows readme, requirements blocks, and install state, but the install/add-to-selection action is a disabled stub until Phase 2/3
- Null-check `requirements` before rendering requirement blocks (may be `null` per manifest)
- Add markdown rendering dependency to `frontend-dashboard/package.json`

Do NOT touch:
- Install buttons (leave disabled/hidden)
- Batch-selection persistence
- Deploy flow navigation
- Job polling or success banners

### Acceptance Criteria
- [ ] Backend: browse, search, and detail endpoints return normalized Nora response shapes and handle registry unavailability with `clawhub_unavailable`.
- [ ] Backend: the detail endpoint parses SKILL.md frontmatter correctly, normalizes `package` → `kind`, and returns `requirements: null` for skills with no `metadata.openclaw` block.
- [ ] Frontend: the ClawHub tab loads browse results on mount, submits search on Enter, clears back to browse results when the query is emptied, and shows loading/empty/error states.
- [ ] Frontend: clicking a skill card opens `SkillDetailPanel` showing readme and parsed requirements; the install action is visible but disabled.
- [ ] End-to-end: a user can open the ClawHub tab on a running agent and see real catalog data with skill details.

### ✅ Gate
Do not proceed to Phase 2 until all acceptance criteria pass and both workers have reported completion.

---

## Phase 2: Deploy-Time Skill Selection
### Goal
Let a user pick ClawHub skills during agent creation and persist those selections only when they click the deploy action.

### Backend (Worker 1)
Files to create/modify:
- `backend-api/routes/agents.ts` — accept `clawhub_skills` in the deploy request body; persist to `agents.clawhub_skills` on INSERT; pass through `addDeploymentJob()` payload

Deploy request body extension:
```json
{
  "clawhub_skills": [
    {
      "source": "clawhub",
      "installSlug": "github",
      "author": "steipete",
      "pagePath": "steipete/github",
      "installedAt": "2026-04-19T00:00:00Z"
    }
  ]
}
```
- `clawhub_skills` is optional; omitting it or passing `[]` is valid
- Persist only the durable identifier fields (`source`, `installSlug`, `author`, `pagePath`, `installedAt`); do not persist catalog metadata (stars, downloads, description, readme)
- The deploy response shape is unchanged — do not add new fields to the deploy response

Do NOT touch:
- Running-agent install routes
- Job polling
- Catalog parsing
- Frontend install polling state

### Frontend (Worker 2)
Files to create/modify:
- `frontend-dashboard/pages/deploy/index.tsx` — change primary button to "Next: Choose Skills"; navigate to the ClawHub selection page carrying agent name and infra context
- `frontend-dashboard/pages/clawhub/index.tsx` — deploy-time skill selection page; catalog + search; bottom actions are only "Deploy Agent & Open Validation" and "Back"
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx` — **deploy-flow mode only in this phase**: shows selected skill count and names; primary action is "Deploy Agent & Open Validation"; install CTA is a disabled stub
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.tsx` — enable the "Add to selection" action (not install) for the deploy flow context

Depends on:
- `GET /api/clawhub/skills`
- `GET /api/clawhub/skills/search`
- `GET /api/clawhub/skills/:slug`
- Deploy route accepting `clawhub_skills` in the request body

Do NOT touch:
- Runtime install polling
- Running-agent install actions in `SkillSelectionTray` (leave as disabled stub)
- Running-agent success banners
- Reconciliation logic

### Acceptance Criteria
- [ ] Backend: `POST /api/agents/deploy` with a `clawhub_skills` array persists those entries to `agents.clawhub_skills` using the durable identifier shape from the manifest.
- [ ] Backend: deploying without `clawhub_skills` (or with `[]`) succeeds unchanged.
- [ ] Frontend: the deploy page button routes to the ClawHub selection page with agent context carried forward.
- [ ] Frontend: the user can browse/search/select skills and click "Deploy Agent & Open Validation" to deploy with skills attached.
- [ ] Frontend: `SkillSelectionTray` shows selected skills and deploy CTA; install CTA is not yet active.
- [ ] End-to-end: a newly deployed agent has the selected skills recorded in `agents.clawhub_skills` and visible in the DB.

### ✅ Gate
Do not proceed to Phase 3 until all acceptance criteria pass and both workers have reported completion.

---

## Phase 3: Running-Agent Install Jobs
### Goal
Allow a user to install one or more ClawHub skills on an already running agent and poll for completion.

### Backend (Worker 1)
Files to create/modify:
- `backend-api/routes/clawhub.ts` — add agent-scoped routes: installed-skills read, install trigger, job polling
- `backend-api/redisQueue.ts` — add enqueue and poll helpers for `clawhubInstalls` queue
- `workers/provisioner/worker.ts` — add the ClawHub install job handler
- `backend-api/middleware/ownership.ts` — extend the agent SELECT to include `backend_type`, `runtime_family`, `container_id`, `status` if not already present
- `backend-api/__tests__/clawhub.test.ts`

API contract:

`GET /api/clawhub/agents/:agentId/skills`
- `200`
  ```json
  { "skills": [{ "slug": "github", "version": "2.1.0" }] }
  ```
  Reads from the lockfile at `/root/.openclaw/workspace/.clawhub/lock.json` inside the container; lockfile shape: `{ "version": 1, "skills": { "github": { "version": "2.1.0", "installedAt": 1700000000000 } } }` — normalize to array by iterating keys.

`POST /api/clawhub/agents/:agentId/skills/:slug/install`
- `202`
  ```json
  { "jobId": "uuid", "agentId": "uuid", "slug": "github", "status": "pending" }
  ```
- `404` `{ "error": "agent_not_found" }`
- `409` `{ "error": "container_not_running", "message": "Start the agent before installing skills." }`
- `409` `{ "error": "unsupported_runtime", "message": "ClawHub installs are only available for Docker-backed OpenClaw agents." }`
- `422` `{ "error": "npm_unavailable", "message": "The clawhub CLI could not be installed. Ensure Node.js is in your base image." }`

  Validation: `backend_type` must be `"docker"`, `runtime_family` must be `"openclaw"`, `status` must be `"running"`.
  Bootstrap: if `clawhub` CLI is missing, run `npm install -g clawhub` first; if `npm` is also missing, return 422.
  Persistence: append to `agents.clawhub_skills` **only** after the job completes successfully.

`GET /api/clawhub/jobs/:jobId`
- `200`
  ```json
  { "jobId": "uuid", "agentId": "uuid", "slug": "github", "status": "pending|running|success|failed", "error": null, "completedAt": null }
  ```
  BullMQ state mapping: `waiting`/`delayed` → `pending`, `active` → `running`, `completed` → `success`, `failed` → `failed`.

Worker install handler (in `workers/provisioner/worker.ts`):
- Receives `agentId`, `slug`, and skill metadata from job payload
- Re-fetches the agent row before execution to confirm container is still running
- Runs `clawhub install <slug> --no-input` in the container via `runContainerCommand(agent, cmd, { timeout })`
- Treats non-zero exit code as job failure; captures output as the error payload
- On success: appends the saved entry shape to `agents.clawhub_skills`

Do NOT touch:
- Deploy-time selection writes
- Catalog browse/search responses
- Frontend deploy flow

### Frontend (Worker 2)
Files to create/modify:
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx` — add install trigger logic and `jobStatuses` state
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.tsx` — enable install and retry actions for running-agent context
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.tsx` — enable "Install X Skills" CTA for running-agent context; show per-skill installing/success/failed states
- `frontend-dashboard/components/Toast.tsx` — add install success and restart-session feedback
- `frontend-dashboard/pages/agents/[id].tsx` — own `showRestartBanner` state at the page level; render restart banner outside any tab panel so it survives tab switches

Polling behavior:
- Call install endpoint once per selected slug; store returned job ids
- Poll `GET /api/clawhub/jobs/:jobId` every 2 seconds per active job
- On `success`: refresh `installedSlugs`, mark skill installed in local state, set `showRestartBanner = true`
- On `failed`: surface error from job record, keep skill available for retry
- Stop polling when panel closes or selection is cleared

Depends on:
- `GET /api/clawhub/agents/:agentId/skills`
- `POST /api/clawhub/agents/:agentId/skills/:slug/install`
- `GET /api/clawhub/jobs/:jobId`

Do NOT touch:
- Deploy-time selection page
- Catalog browsing endpoints
- Reconciliation on redeploy

### Acceptance Criteria
- [ ] Backend: install endpoint validates agent ownership, runtime type, and container status correctly, returning the right error codes per the manifest.
- [ ] Backend: install jobs are enqueued; the worker runs `clawhub install <slug> --no-input` inside the container; job polling returns correct normalized statuses.
- [ ] Backend: `agents.clawhub_skills` is updated only after a successful install; failed installs leave the row unchanged.
- [ ] Frontend: a running agent can trigger install on one or more selected skills; each skill shows installing/success/failed state independently.
- [ ] Frontend: on success, the restart-session banner appears on the agent detail page and persists when the user switches to another tab.
- [ ] End-to-end: a selected skill is installed into the running container, the lockfile is updated, and the UI reflects the new installed state.

### ✅ Gate
Do not proceed to Phase 4 until all acceptance criteria pass and both workers have reported completion.

---

## Phase 4: Reconciliation On Deploy Or Recreate
### Goal
Ensure future deploys and redeploys reinstall only the missing saved skills from `agents.clawhub_skills` into the new container.

### Backend (Worker 1)
Files to create/modify:
- `workers/provisioner/worker.ts` — add reconciliation helper called after `provisioner.create()` succeeds and the agent row is updated to `status = "running"` (after the block around lines 478–516)

Reconciliation logic:
1. Read `agents.clawhub_skills` for the agent
2. Read the installed-skill lockfile from the container (`/root/.openclaw/workspace/.clawhub/lock.json`)
3. Compute the set difference: saved `installSlug` values not present as lockfile keys
4. For each missing skill: run `clawhub install <installSlug> --no-input` via `runContainerCommand(...)`
5. Log success/failure per skill; do not fail the entire deploy if one skill fails to reconcile

No new public API routes are required for this phase.

Do NOT touch:
- Browse/search catalog endpoints
- Running-agent install API
- Frontend selection UI

### Frontend (Worker 2)
Files to create/modify:
- `frontend-dashboard/pages/agents/[id].tsx` — verify `showRestartBanner` state survives a full page navigation back to the agent after redeploy
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.tsx` — after a redeploy, re-fetch `GET /api/clawhub/agents/:agentId/skills` so the installed state refreshes correctly

Depends on:
- Persisted `agents.clawhub_skills` from Phase 2
- `GET /api/clawhub/agents/:agentId/skills` from Phase 3

Do NOT touch:
- Catalog browse/search layout
- Deploy-time selection page
- Any new API routes

### Acceptance Criteria
- [ ] Backend: redeploying an agent triggers reconciliation; only skills missing from the container lockfile are installed.
- [ ] Backend: skills already present in the lockfile are not reinstalled.
- [ ] Backend: a single reconciliation failure does not abort the deploy or other reconciliation installs.
- [ ] Frontend: after redeploy, the ClawHub tab reflects the reconciled installed state when the user opens the agent.
- [ ] End-to-end: a redeployed agent comes back with the expected ClawHub skills present in the container lockfile.

### ✅ Gate
Do not proceed to Phase 5 until all acceptance criteria pass and both workers have reported completion.

---

## Phase 5: Tests And Cleanup
### Goal
Lock in the feature with complete test coverage so future engineers can maintain it safely.

### Backend (Worker 1)
Files to create/modify:
- `backend-api/__tests__/clawhub.test.ts`
- Any route or worker file needing cleanup from earlier phases

Required test coverage (each behavior should have at least one test):
- **Catalog**: browse returns normalized skill list; registry unavailability returns `clawhub_unavailable`
- **Search**: valid query returns results; missing `q` returns `missing_query`; registry down returns `clawhub_unavailable`
- **Detail**: slug found returns full shape including `requirements`; slug not found returns `skill_not_found`; skill with no `metadata.openclaw` block returns `requirements: null`
- **SKILL.md parsing**: `package` field in frontmatter is normalized to `kind` in the response; all four requirement arrays default to `[]` when absent
- **Installed skills read**: lockfile is read and normalized to `{ skills: [{ slug, version }] }`
- **Install route**: non-owned agent returns 404; non-Docker agent returns `unsupported_runtime` 409; stopped container returns `container_not_running` 409; missing npm returns `npm_unavailable` 422; valid agent enqueues job and returns 202 with `pending` status
- **Job polling**: BullMQ states map correctly to `pending`/`running`/`success`/`failed`
- **Persistence**: `agents.clawhub_skills` is updated only on success; failed job leaves row unchanged
- **Reconciliation**: diff logic installs only missing skills; already-installed skills are skipped

Do NOT touch:
- User-facing behavior
- Schema semantics
- Route names or API shapes

### Frontend (Worker 2)
Files to create/modify:
- Any cleanup in `frontend-dashboard/components/agents/openclaw/*`
- `frontend-dashboard/pages/clawhub/index.tsx` if any edge cases need polish

Do NOT touch:
- API shapes
- Database schema
- Worker job orchestration

### Acceptance Criteria
- [ ] Backend: all behaviors listed in the required test coverage above have passing tests.
- [ ] Backend: no test imports or mocks bypass the Nora error/response shape conventions.
- [ ] Frontend: no console errors or unhandled promise rejections in the ClawHub flows.
- [ ] End-to-end: a new engineer can follow the manifest and this plan to understand the full feature without guessing at any step.

### ✅ Gate
Do not proceed past this phase until all acceptance criteria pass and both workers have reported completion.
