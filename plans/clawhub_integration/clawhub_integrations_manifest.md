# ClawHub Integration Manifest

## Overview
ClawHub integration in Nora has two user-facing flows and one shared backend state model.

- For new agents, the user chooses ClawHub skills during the deploy flow, and Nora saves those selections on the agent record when the user clicks `Deploy Agent & Open Validation`.
- For already running agents, the user opens a `ClawHub` tab inside the agent detail page, searches the catalog, inspects a skill, and installs one or more selected skills immediately.
- In both flows, Nora stores the intended skill list in `agents.clawhub_skills`, while the running container remains the source of truth for what is actually installed right now.

## Backend

### Goals
- Proxy all ClawHub discovery and install traffic through Nora so the frontend never talks to ClawHub directly.
- Support the three backend responsibilities we need for v1:
  - catalog discovery and detail lookup
  - deploy-time persistence of selected skills onto the agent record
  - runtime install, job polling, and reconciliation against running containers
- Reuse Nora's existing ownership, container exec, and BullMQ patterns instead of introducing a new persistence or job system.

### Existing Nora Patterns To Reuse
- Express routers under `backend-api/routes`
- Route mounting in `backend-api/server.js`
- Ownership checks via `requireOwnedAgent(...)`
- Container exec through `runContainerCommand(...)` in `backend-api/authSync.js`
- Async jobs through BullMQ in `backend-api/redisQueue.js` and `workers/provisioner/worker.js`

### Runtime And Container Facts
- Canonical OpenClaw workspace path: `/root/.openclaw/workspace`
- Legacy mirrored agent path: `/root/.openclaw/agents/main/agent`
- V1 installed-skills lockfile path: `/root/.openclaw/workspace/.clawhub/lock.json`
- Existing Docker-backed OpenClaw agents already support command execution through Nora's backend abstractions

### Locked Backend Decisions
- Add a dedicated `clawhub_skills` column to the `agents` table instead of storing ClawHub selections inside `template_payload`
- Persist only successful ClawHub installs in `agents.clawhub_skills`
- Failed installs are never saved to the `agents` row
- Existing running agents support immediate install attempts from the Nora UI
- New deploys and later container recreations reconcile from `agents.clawhub_skills`
- Reconciliation installs only saved skills that are missing from the container; it does not blindly reinstall all saved skills
- Nora's deployment worker owns reconciliation, while the actual install commands run inside the container

### Agent Skill Persistence Model
- `agents.clawhub_skills` is the durable source of truth for which ClawHub skills an agent should keep across future deploys/recreates
- The column should store only the minimum durable identifiers needed to reapply a skill and link it back to the catalog
- Recommended saved entry shape:
```json
{
  "source": "clawhub",
  "installSlug": "sonoscli",
  "author": "steipete",
  "pagePath": "steipete/github",
  "installedAt": "2026-04-17T15:48:45Z"
}
```
- Do not persist volatile catalog metadata like stars, downloads, description, readme, or parsed requirements on the `agents` row

### Backend Feature Areas

#### 1. ClawHub Data Access
This layer is responsible for everything Nora needs to show the ClawHub catalog in the UI without exposing the frontend to ClawHub directly.

Responsibilities:
- Discover the registry base URL through `GET https://clawhub.ai/.well-known/clawhub.json`
- Fetch the browse list, search results, and detail payloads from ClawHub
- Fetch the raw `SKILL.md` file for a selected skill
- Parse `SKILL.md` frontmatter and extract:
  - `metadata.openclaw.requires`
  - `metadata.openclaw.install`
- Return `requirements: null` when no `metadata.openclaw` block exists
- Normalize all upstream responses into a stable Nora shape that the frontend can render consistently

Routes powered by this layer:
- `GET /api/clawhub/skills`
  Browse default skills with Nora-owned pagination shape
- `GET /api/clawhub/skills/search`
  Search skills by query with Nora-owned validation and error responses
- `GET /api/clawhub/skills/:slug`
  Return normalized skill metadata plus raw `SKILL.md` content and parsed requirements

Implementation touchpoints:
- Modify `backend-api/server.js` to mount the ClawHub route
- Modify `backend-api/package.json` to add a frontmatter/YAML parser dependency
- Create `backend-api/routes/clawhub.js`
- Create `backend-api/clawhubClient.js`
- Create `backend-api/__tests__/clawhub.test.js`

Primary implementation focus:
- `backend-api/clawhubClient.js`
- read-only route handlers in `backend-api/routes/clawhub.js`
- route registration in `backend-api/server.js`
- shared JSON/error handling conventions in `backend-api/routes/marketplace.js`
- request/response wrapper patterns in `backend-api/routes/integrations.js`

Implementation details:
- Create a small client module that knows how to:
  - discover the registry base URL from `/.well-known/clawhub.json`
  - call browse/search/detail endpoints
  - fetch raw `SKILL.md`
  - parse frontmatter and return a normalized skill object
- Keep the route handlers thin:
  - validate query params
  - call the client
  - translate client/network failures into Nora errors
  - always return the Nora response shape expected by the frontend
- Follow the same flat `res.status(...).json({ error, message })` style already used in `backend-api/routes/marketplace.js` and `backend-api/routes/integrations.js`
- Add any ClawHub-specific helpers in `backend-api/clawhubClient.js` rather than embedding fetch/parse logic directly in the route file

#### 2. Install Preparation And Download Orchestration
This layer is responsible for deciding whether Nora can install a skill for a specific agent, when to save the selected skill list, and how to prepare the running container before the actual install command runs.

Responsibilities:
- Confirm the agent exists, belongs to the current user, and is a Docker-backed OpenClaw agent
- Confirm the target container is currently running before attempting an install
- Distinguish between two cases:
  - an existing running agent, where Nora should install immediately
  - a new deploy or redeploy, where Nora should only save the desired skills and reconcile them later
- Read the currently installed skills from `/root/.openclaw/workspace/.clawhub/lock.json`
- Check whether the `clawhub` CLI exists in the container
- If `clawhub` is missing, bootstrap it with `npm install -g clawhub`
- If `npm` is also missing, return `422`
- Enqueue install work and return a pollable job id instead of blocking the request
- Persist a skill into `agents.clawhub_skills` only after the install succeeds
- Surface normalized job status values to the frontend: `pending`, `running`, `success`, and `failed`

Deployment-time persistence responsibilities:
- Accept a selected-skill list during agent creation or redeploy flows
- Store the selected skills on `agents.clawhub_skills` as the desired state for that agent
- Keep that write path separate from the runtime install job so creation does not depend on the container already existing
- Reuse the same minimum durable identifier shape used by running-agent installs

Persistence semantics:
- For a running agent:
  - attempt the install first
  - only append to `agents.clawhub_skills` after success
- For a new deploy:
  - skills selected during agent creation can be written to `agents.clawhub_skills` as deploy-time desired state
  - later deployment reconciliation installs them into the container
- Failed installs never create or append saved skill entries

Routes powered by this layer:
- `GET /api/clawhub/agents/:agentId/skills`
  Read only the installed skills from the lockfile inside the agent container
- `POST /api/clawhub/agents/:agentId/skills/:slug/install`
  Validate the agent, bootstrap `clawhub` if needed, enqueue install work, and return a pollable job ID
- `GET /api/clawhub/jobs/:jobId`
  Return Nora-owned async install status
- Agent creation / deploy routes in `backend-api/routes/agents.js` or the existing deploy flow route
  Persist the selected skills onto `agents.clawhub_skills` when the user clicks `Deploy Agent & Open Validation`

Implementation touchpoints:
- Modify `backend-api/routes/agents.js` or the existing deploy flow route to persist selected skills on deploy
- Modify `backend-api/redisQueue.js` to add the ClawHub install queue plumbing
- Modify `backend-api/middleware/ownership.js` or reuse its lookup pattern for agent scoping
- Modify `backend-api/routes/clawhub.js` to expose installed-skill reads, installs, and polling
- Modify `workers/provisioner/worker.js` to execute installs and reconciliation
- Create `backend-api/routes/clawhub.js`
- Create `backend-api/clawhubClient.js`
- Create `backend-api/__tests__/clawhub.test.js`

Primary implementation focus:
- agent-aware route handlers in `backend-api/routes/clawhub.js`
- queue definitions in `backend-api/redisQueue.js`
- existing agent ownership checks in `backend-api/middleware/ownership.js`
- agent lifecycle patterns in `backend-api/routes/agents.js`
- runtime/service lookup patterns in `backend-api/routes/integrations.js`
- agent creation and deploy persistence in `backend-api/routes/agents.js` and `backend-api/routes/marketplace.js`

Implementation details:
- In `backend-api/routes/clawhub.js`, implement agent lookup and validation using the same style as `backend-api/routes/agents.js` and `backend-api/routes/integrations.js`
- For running-agent installs:
  - load the owned agent row
  - confirm `backend_type`, `runtime_family`, `deploy_target`, `container_id`, and `status`
  - reject non-Docker or non-OpenClaw agents early with a clear 409 response
- For installed-skill reads:
  - inspect the running container
  - read `/root/.openclaw/workspace/.clawhub/lock.json`
  - normalize the result into `{ skills: [{ slug, version }] }`
- For install requests:
  - enqueue the job instead of executing directly in the request
  - return a job identifier immediately
  - only persist to `agents.clawhub_skills` after the job completes successfully
- Mirror the agent ownership lookup shape already used by `requireOwnedAgent(...)`, but extend it with the extra columns needed for container/runtime checks

#### 3. Container Injection And Runtime Execution
This layer is responsible for the side-effectful work that happens after the API accepts an install request.

Responsibilities:
- Execute `clawhub install <slug> --no-input` from the OpenClaw workspace context
- Ensure the install runs against `/root/.openclaw/workspace`
- Let the `clawhub` CLI download the skill directly inside the container workspace rather than downloading artifacts onto the Nora host
- Capture command output and map failures into job error payloads
- Re-read `.clawhub/lock.json` after install if needed to confirm the resulting installed state
- Mark the async job as `success` or `failed` for frontend polling
- Treat session restart as a post-install activation requirement, not part of the install itself

Reconciliation semantics:
- For deploy/start/recreate flows, the worker reads `agents.clawhub_skills`
- It compares the saved entries against the container's installed-skill state
- It installs only the saved skills that are missing
- It does not reinstall saved skills that are already present

Primary implementation focus:
- BullMQ worker path in `workers/provisioner/worker.js`
- existing container command execution path via `runContainerCommand(...)`
- worker/deployment flow in `workers/provisioner/worker.js`
- container bootstrap and workspace layout in `agent-runtime/lib/runtimeBootstrap.js`
- existing Docker exec/install helpers in `workers/provisioner/backends/docker.js`
- agent runtime conventions in `agent-runtime/lib/server.js`

Implementation touchpoints:
- Modify `workers/provisioner/worker.js` to run install and reconciliation jobs
- Modify `backend-api/redisQueue.js` to enqueue and poll ClawHub install jobs
- Modify `workers/provisioner/backends/docker.js` only if the existing exec helper cannot express the install flow
- Modify `agent-runtime/lib/runtimeBootstrap.js` only if workspace layout details need to be surfaced more explicitly
- Modify `agent-runtime/lib/server.js` only if runtime conventions need to expose install state more directly

Implementation details:
- Add a worker-side install handler that:
  - receives the agent id, slug, and the skill metadata the route stored in the job payload
  - resolves the current agent row again before execution
  - verifies the container is still present and running
  - runs `clawhub install <slug> --no-input` inside the container
  - treats a non-zero exit as a job failure and captures the error text
- Add a reconciliation helper for startup/redeploy flows that:
  - reads `agents.clawhub_skills`
  - reads the installed skill lockfile from the container
  - computes the set difference of saved vs installed skills
  - installs only the missing entries
- Keep install/reconciliation logic in the worker rather than the route so requests stay fast and the job can be polled
- Use `runContainerCommand(...)` if the implementation can reuse the existing shell/exec wrapper; otherwise add the smallest new helper that still follows the same error/timeout conventions

#### Async Job Model
- Use BullMQ for v1 instead of adding a new SQL job table
- Provide a Nora-normalized polling endpoint:
  - `pending`
  - `running`
  - `success`
  - `failed`
- Map BullMQ states to that simplified API contract

#### Backend Error Model
- `clawhub_unavailable`
- `missing_query`
- `skill_not_found`
- `agent_not_found`
- `container_not_running`
- `unsupported_runtime`
- `npm_unavailable`

## Frontend

### Goals
- Support two operator flows:
  - a deploy-time ClawHub selection step for new agents
  - an existing-agent `ClawHub` tab for browsing and installing skills on a running agent
- Keep the UI agent-scoped so it is always clear which agent receives the skill
- Let operators search, inspect, multi-select, batch install, and then see restart guidance after a successful install

### Existing Nora Patterns To Reuse
- Agent detail page at `frontend-dashboard/pages/agents/[id].js`
- OpenClaw subtab composition in `frontend-dashboard/components/agents/OpenClawTab.js`
- Local component state with `useState` / `useEffect`
- API access through `fetchWithAuth`
- Toast feedback through `useToast`

### Frontend Feature Areas

#### 0. Agent Creation Skill Selection Page
This is the page that appears after the user fills in agent name and infrastructure specs and clicks `Next: Choose Skills` from the deploy flow.
It lets the user decide which ClawHub skills should be attached to the new agent before the agent is actually deployed.

Responsibilities:
- Act as the continuation of the agent-initiation flow
- Show the ClawHub catalog before the agent is deployed
- Let the user select one or more skills to save onto the new agent
- Return the user to the deploy/validation action from this page when ready

Primary implementation focus:
- `frontend-dashboard/pages/deploy/index.js`
- `frontend-dashboard/pages/clawhub/index.js` or the chosen routed equivalent
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js`

Implementation details:
- Change the deploy page primary button to navigate into the ClawHub selection page instead of immediately deploying
- Carry forward the new agent's name and infrastructure context into the ClawHub page
- On the ClawHub page, show the catalog, let the user search and select skills, and keep the bottom actions to only `Deploy Agent & Open Validation` and `Back`
- Persist the selected skills when the user clicks `Deploy Agent & Open Validation`
- Pass the selected skills back into the deploy request so the backend can save them on `agents.clawhub_skills`

Implementation touchpoints:
- Modify `frontend-dashboard/pages/deploy/index.js` to route into the ClawHub selection page
- Modify `frontend-dashboard/pages/agents/[id].js` only if deploy flow context needs to be preserved across navigation
- Create `frontend-dashboard/pages/clawhub/index.js` or the chosen routed equivalent
- Create `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillSearchBar.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillGrid.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillCard.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.js`

Page layout decisions:
- Use a card grid similar to the rest of Nora rather than a wizard layout
- Submit search only when the user presses `Enter`
- Present selected skills in a sticky summary panel so the user can always see what will be deployed
- Let users select skills directly from cards and also from the detail panel
- Keep the overall page feeling like a normal Nora operator page, not a marketing marketplace clone

#### 1. Existing-Agent ClawHub Tab
This is the top-level UI surface for browsing and installing skills on an already running agent.
It should feel like part of the agent detail page, not a separate marketplace site.

Responsibilities:
- Add a visible `ClawHub` tab on the agent detail page
- Pass the current `agentId` into the skills experience
- Keep the browse experience scoped to the currently viewed agent
- Preserve agent-level post-install messaging outside the panel so it survives subtab changes
- Support selecting multiple skills before install
- Allow batch install from the detail popup or selected-card tray

Primary implementation focus:
- `frontend-dashboard/pages/agents/[id].js`
- `frontend-dashboard/components/agents/OpenClawTab.js`
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.js`

Implementation details:
- Add a new `ClawHub` subtab to the agent detail tab navigation
- Mount a dedicated ClawHub panel from that tab
- Pass down the agent id and any installed-skill state the panel needs
- Keep the restart banner at the agent detail page level, not buried inside the browser panel
- Let users select skills from the grid and from the detail popup
- Show the current selection count and a clear install action for multiple selected skills
- Keep install actions scoped to the selected agent only

Implementation touchpoints:
- Modify `frontend-dashboard/pages/agents/[id].js` to own the tab state and restart banner state
- Modify `frontend-dashboard/components/agents/OpenClawTab.js` to add the `ClawHub` tab
- Create `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.js`

#### 2. Skill Discovery And Search
This part of the UI lets the user search the ClawHub catalog and browse popular skills.
It is shared by both the deploy-time selection page and the existing-agent `ClawHub` tab.

Responsibilities:
- Load default browse results on mount
- Let the user search ClawHub skills
- Show loading, empty, and unavailable states
- Mark already-installed skills in the results

Primary implementation focus:
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- `frontend-dashboard/components/agents/openclaw/SkillSearchBar.js`
- `frontend-dashboard/components/agents/openclaw/SkillGrid.js`
- `frontend-dashboard/components/agents/openclaw/SkillCard.js`

Implementation details:
- Keep the search input controlled in React state
- Submit search only when the user presses `Enter`
- Reset to browse results when the query is cleared
- Render cards using the Nora response shape from `/api/clawhub/skills` and `/api/clawhub/skills/search`
- Show a clear empty-state message when search returns no matches
- Show a clear error state when the registry is unavailable
- Annotate cards as already installed by comparing returned slugs against the agent's installed-skill state

Implementation touchpoints:
- Create `frontend-dashboard/components/agents/openclaw/SkillSearchBar.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillGrid.js`
- Create `frontend-dashboard/components/agents/openclaw/SkillCard.js`
- Modify `frontend-dashboard/components/agents/openclaw/ClawHubTab.js` to coordinate browse/search state

#### 3. Skill Detail And Requirements
This is the part of the UI that shows one skill's full details and the install requirements extracted from `SKILL.md`.
Users should be able to inspect a skill before deciding whether to add it to the current batch selection or install it immediately on a running agent.

Responsibilities:
- Open a detail panel or modal for a selected skill
- Render the returned `readme`
- Show parsed requirement details
- Show install state for the selected skill
- Allow the current selection to be added to the batch install set from inside the panel

Primary implementation focus:
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js`
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`

Implementation details:
- Fetch full skill detail when the user selects a card
- Render markdown for `readme` in a readable, scrollable panel
- Present the parsed requirements in separate blocks:
  - required binaries
  - required environment variables
  - config entries if present
  - install method if present
- Keep the detail panel aware of whether the skill is already installed on the current agent
- Disable the install action if the skill is already present

Implementation touchpoints:
- Create `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js`
- Modify `frontend-dashboard/components/agents/openclaw/ClawHubTab.js` to open and coordinate the detail panel
- Modify `frontend-dashboard/package.json` to add markdown rendering support

#### 4. Batch Install And Polling UX
This is the interaction loop for starting install jobs on an already running agent and waiting for the backend to report success or failure.
Because the install happens inside the running container, the UI should show progress, success, or failure per selected skill.

Responsibilities:
- Trigger install through Nora backend only
- Queue one job per selected skill
- Poll each job status every 2 seconds
- Update installed state only after success
- Show retry affordance for failed items
- Show success/failure feedback with a clear next action

Primary implementation focus:
- `frontend-dashboard/components/agents/openclaw/ClawHubTab.js`
- `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js`
- `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.js`
- `frontend-dashboard/components/Toast.js`

Implementation details:
- When the user clicks install on a running agent:
  - call the Nora install endpoint once for each selected skill
  - store the returned job ids
  - switch the selected skills into an installing state
- Poll each job endpoint until it returns `success` or `failed`
- On success:
  - refresh the installed-skill list
  - mark the skill as installed in local state
  - show the restart-session toast
- On failure:
  - surface the error from the job record
  - keep the skill available for retry
- Keep polling bounded to the active selection so it stops when the user changes skills, closes the panel, or clears the batch selection

Implementation touchpoints:
- Modify `frontend-dashboard/components/agents/openclaw/ClawHubTab.js` to trigger installs and track job ids
- Modify `frontend-dashboard/components/agents/openclaw/SkillDetailPanel.js` to expose install and retry actions
- Create `frontend-dashboard/components/agents/openclaw/SkillSelectionTray.js`
- Modify `frontend-dashboard/components/Toast.js` to show install and restart feedback
- Modify `frontend-dashboard/pages/agents/[id].js` to keep the banner state alive across tab changes

#### 5. Post-Install Banner State
This is the agent-level reminder that a successful install still needs a session restart before OpenClaw picks it up.
The reminder should stay visible on the agent page even if the user switches tabs inside that page.

Responsibilities:
- Show a persistent agent-level banner reminding the operator to restart the session
- Keep that banner visible on the agent detail page after a successful install
- Make the banner survive subtab switches and modal closes

Primary implementation focus:
- `frontend-dashboard/pages/agents/[id].js`
- `frontend-dashboard/components/Toast.js`

Implementation details:
- Update the agent detail page state after a successful install so it can render a persistent reminder
- Phrase the banner as an action reminder rather than an error state
- Keep the banner count/wording simple enough for future extension if multiple skills are added at once

### Frontend State Model
- `query`
- `skills`
- `loading`
- `error`
- `selectedSkill`
- `installedSlugs`
- install job status for the active skill on running-agent installs
- page-level restart-session banner state

## Shared API Contract Between Frontend And Backend

### Contract Principle
- The frontend talks only to Nora
- The backend talks to ClawHub
- The frontend should never depend on raw ClawHub response shapes, pagination quirks, or discovery behavior
- The backend is responsible for normalization

### Discovery Contract

#### `GET /api/clawhub/skills?limit=20&cursor=<cursor>`
Success response:
```json
{
  "skills": [
    {
      "slug": "github",
      "name": "GitHub",
      "description": "Manage issues, PRs, and repos via the gh CLI.",
      "downloads": 94200,
      "stars": 1200,
      "updatedAt": "2026-04-01T12:00:00Z"
    }
  ],
  "cursor": "next-or-null"
}
```

Error response:
```json
{
  "error": "clawhub_unavailable",
  "message": "Could not reach ClawHub registry."
}
```

#### `GET /api/clawhub/skills/search?q=<query>&limit=20`
Success response:
- Same shape as browse

Validation error:
```json
{
  "error": "missing_query",
  "message": "q is required."
}
```

Unavailable error:
```json
{
  "error": "clawhub_unavailable",
  "message": "Could not reach ClawHub registry."
}
```

#### `GET /api/clawhub/skills/:slug`
Success response:
```json
{
  "slug": "github",
  "name": "GitHub",
  "description": "Manage issues, PRs, and repos via the gh CLI.",
  "downloads": 94200,
  "stars": 1200,
  "updatedAt": "2026-04-01T12:00:00Z",
  "readme": "# GitHub Skill\n...",
  "requirements": {
    "bins": ["gh"],
    "env": ["GITHUB_TOKEN"],
    "config": [],
    "install": [
      {
        "kind": "node",
        "package": "@github/gh-cli"
      }
    ]
  }
}
```

Not found error:
```json
{
  "error": "skill_not_found",
  "message": "No skill found with slug: github"
}
```

### Agent-Scoped Contract

#### `GET /api/clawhub/agents/:agentId/skills`
Success response:
```json
{
  "skills": [
    { "slug": "github", "version": "2.1.0" },
    { "slug": "gog", "version": "1.0.4" }
  ]
}
```

#### `POST /api/clawhub/agents/:agentId/skills/:slug/install`
Accepted response:
```json
{
  "jobId": "uuid-or-bullmq-id",
  "agentId": "uuid",
  "slug": "github",
  "status": "pending"
}
```

Error responses:
```json
{ "error": "agent_not_found" }
```

```json
{
  "error": "container_not_running",
  "message": "Start the agent before installing skills."
}
```

```json
{
  "error": "unsupported_runtime",
  "message": "ClawHub installs are only available for Docker-backed OpenClaw agents."
}
```

```json
{
  "error": "npm_unavailable",
  "message": "The clawhub CLI could not be installed. Ensure Node.js is in your base image."
}
```

Behavior notes:
- This route attempts an immediate runtime-local install for an existing running agent
- The selected skill is appended to `agents.clawhub_skills` only after the install succeeds
- If the install fails, the agent record remains unchanged
- For batch install, the frontend calls this endpoint once per selected slug

### Job Polling Contract

#### `GET /api/clawhub/jobs/:jobId`
Success response:
```json
{
  "jobId": "uuid-or-bullmq-id",
  "agentId": "uuid",
  "slug": "github",
  "status": "pending | running | success | failed",
  "error": null,
  "completedAt": null
}
```

State mapping:
- BullMQ `waiting` / `delayed` -> `pending`
- BullMQ `active` -> `running`
- BullMQ `completed` -> `success`
- BullMQ `failed` -> `failed`

### Frontend Expectations
- All calls go through `fetchWithAuth`
- All non-2xx responses include a flat `error`
- Include `message` when the UI should display human-readable detail
- `agentId` comes from `router.query.id` in `frontend-dashboard/pages/agents/[id].js`

## Scope Decisions

### Included In V1
- Browse skills
- Search skills
- Skill detail view
- Installed skill listing
- Async install with polling
- Docker-backed OpenClaw agents only
- Immediate install for existing running agents
- Saved successful installs in `agents.clawhub_skills`
- Deploy/start reconciliation that installs only missing saved skills

### Excluded From V1
- Uninstall
- Version pinning
- Streaming install logs
- Auto-restarting the session
- Compatibility pre-checks
- K8s, Proxmox, Hermes, and other non-Docker runtime paths
