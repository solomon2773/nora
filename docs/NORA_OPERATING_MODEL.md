# Nora Operating Model

## Canonical repo and environments
- GitHub repo: `https://github.com/solomon2773/nora`
- Local working path: `/root/.openclaw/workspace/projects/nora`
- Stage environment: `11.11.10.10`
- Stage domain: `stage.orionconnect.io`

## Autonomy boundaries
Allowed without additional approval:
- pull / fetch
- create branches
- commit code
- open PRs / issues

Requires CEO approval:
- merge to `main`
- deploy live

## Discord workspace model
Project Category -> Department Channel -> Task Thread

### Parent channels
- `#product`
- `#development`
- `#testing-qa`
- `#security`
- `#ui-ux`
- `#marketing`
- `#observability`
- `#blockers`
- `#executive-briefs`

## Thread rules
- One task = one thread
- One sub-agent = one thread
- Keep discussion out of parent channels except for:
  - task creation
  - milestone summaries
  - blockers
  - approval requests
- Parent channels are department hubs
- Threads are the actual workspaces

## Team roles
### Product Lead
Owns roadmap, prioritization, issue grooming, release scope, and acceptance criteria.

### Lead Engineer
Owns architecture review, implementation, bug fixes, refactors, and code quality.

### QA / Testing Lead
Owns regression coverage, bug reproduction, smoke testing, e2e validation, and release confidence.

### Security Lead
Owns auth/session review, secret-handling compliance, dependency risk review, and hardening.

### UI / UX Lead
Owns onboarding, usability, interaction consistency, friction reduction, and copy clarity.

### Growth Lead
Owns positioning, contributor marketing, launch messaging, README gaps, and adoption experiments.

### Observability Lead
Owns logging, health checks, diagnostics, visibility gaps, and reliability instrumentation.

### Blockers Coordinator
Owns blocker tracking, dependency mapping, escalation, and approval routing.

## Thread naming format
Use:

`<type>-<scope>-<short-target>`

Examples:
- `feat-dashboard-user-settings`
- `bug-auth-token-refresh`
- `qa-e2e-onboarding-smoke`
- `security-session-hardening`
- `ux-first-run-experience`
- `mktg-readme-positioning`
- `obs-runtime-error-tracing`
- `blocked-waiting-for-approval`

## Issue / label standard
- `product`
- `bug`
- `architecture`
- `marketing`
- `blocked`
- `observability`
- `good first issue`

Recommended additions aligned to lanes:
- `testing-qa`
- `security`
- `ui-ux`

## Heartbeat responsibilities per lane
### Product
- top priority
- scope changes
- acceptance criteria quality
- release realism
- approval needs

### Development
- branch / PR progress
- bugs fixed / introduced
- stalled implementation threads
- technical risks

### Testing / QA
- unit/integration/e2e status
- regression risks
- flaky tests
- release readiness

### Security
- auth/session risks
- secrets-handling compliance
- dependency issues
- hardening gaps

### UI / UX
- onboarding friction
- confusing flows
- inconsistent UI
- broken layouts
- copy issues

### Marketing
- positioning clarity
- launch assets
- community/content progress
- growth opportunities

### Observability
- logging coverage
- runtime failures
- health-check coverage
- recurring incident patterns

### Blockers
- items blocked more than one cycle
- anything failed three times
- CEO approval queue
- cross-lane dependency waits

## Executive Brief format
Every executive update should include:
1. Active operations
2. Key project updates
3. Blockers / approvals needed
4. Token Usage / Compute Burn
5. User Acquisition / Growth
6. Revenue / Monetization
7. Recommended next moves

## Notes
- Do not transmit secrets or `.env` contents in chat, reports, issues, or PRs.
- Stage LXC is the preferred active development environment for execution workloads.
- Aggressive token budget is authorized, but work should still be broken into bounded tasks with clear outputs.
