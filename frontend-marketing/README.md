# Frontend Marketing

Public-facing marketing site for Nora. Built with Next.js 14 and Tailwind CSS.

## Overview

Runs on `/` behind nginx. Serves the landing page, deployment/support-path page, login, and signup pages. Does not require authentication.

## Pages

| Route | Description |
|---|---|
| `/` | Landing page — positioning, product facts, feature grid, CTA |
| `/pricing` | Public deployment, support, and commercial-path page |
| `/login` | Login form — email/password + Google/GitHub OAuth |
| `/signup` | Registration form — name, email, password |

## Development

```bash
# Runs automatically in Docker Compose with hot reload
docker compose logs -f frontend-marketing

# Local development (outside Docker)
cd frontend-marketing
npm install
npm run dev   # Starts on port 3000
```

## Styling

Uses Tailwind CSS with a dark-blue gradient theme. Global styles in `styles/globals.css`.
