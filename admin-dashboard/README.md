# Admin Dashboard

Internal administration panel for Nora platform operators. Built with Next.js.

## Overview

Runs on `/admin/*` behind nginx. Provides platform-wide visibility into users, agents, and system health.

## Features

- **Ops Overview** — platform-wide metrics, queue health, recent audit activity, and DLQ awareness
- **Fleet Management** — global agent list, lifecycle actions, runtime metadata, telemetry samples, and live logs
- **Queue Recovery** — dead-letter inspection and retry flows for failed deployment jobs
- **User Management** — role changes, agent counts, and account deletion with agent cleanup
- **Marketplace Moderation** — review and remove published marketplace listings

## Development

```bash
# Runs automatically in Docker Compose with hot reload
docker compose logs -f admin-dashboard

# Local development (outside Docker)
cd admin-dashboard
npm install
npm run dev   # Starts on port 3000 by default (use PORT=3002 to override)
```
