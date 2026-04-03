# Nora Install Guide

This guide is for teams evaluating Nora from the open-source repo.

The recommended trust path is to start with a single self-hosted install, prove the operator workflow, and only expand the deployment footprint after the product earns that trust.

The fastest trustworthy proof path is still:

1. install Nora
2. create the operator account
3. add one LLM provider key
4. deploy one OpenClaw agent
5. verify chat, logs, and terminal from the same control plane

If those steps work cleanly, Nora has already proven the core self-hosted value.

## Choose the install route

### Recommended: one-line install

**macOS / Linux / WSL2**

```bash
curl -fsSL https://raw.githubusercontent.com/solomon2773/nora/master/setup.sh | bash
```

**Windows (PowerShell)**

```powershell
iwr -useb https://raw.githubusercontent.com/solomon2773/nora/master/setup.ps1 | iex
```

Use this path if you want Nora to:
- clone the repo automatically
- check Docker / Compose / Git prerequisites
- generate secrets
- create the initial admin account
- start the stack and take you toward first value quickly

### Manual install

```bash
git clone https://github.com/solomon2773/nora.git
cd nora
bash setup.sh
```

Or configure by hand with `.env` and `docker compose up -d` if you want full control over the setup process.

## First 15 minutes after install

### 1. Open the product

- `http://localhost:8080` — landing page
- `http://localhost:8080/login` — sign in
- `http://localhost:8080/signup` — create operator account
- `http://localhost:8080/app/dashboard` — overview
- `http://localhost:8080/app/deploy` — deploy first agent

### 2. Add one provider key

In **Settings**, save one supported LLM provider key.

### 3. Deploy one OpenClaw agent

Go to **Deploy**, create one agent, and wait for it to start.

### 4. Validate operator value

Open the agent detail page and confirm:
- Chat works
- Logs are visible
- Terminal access works

## If you get stuck

| Situation | Best next step |
|---|---|
| You want to keep self-hosting and just need the docs | [README Quick Start](../README.md#quick-start) |
| You hit a bug or broken instruction | [GitHub Issues](https://github.com/solomon2773/nora/issues) |
| You want rollout help or paid support without giving up self-hosting | [GitHub Discussions](https://github.com/solomon2773/nora/discussions) |
| You do not want a pure DIY path anymore | [Pricing / deployment paths](https://nora.solomontsao.com/pricing) |
| You want a hosted evaluation, managed PaaS, or custom deployment conversation | [Hosted evaluation signup](https://nora.solomontsao.com/signup) |

## Upgrade paths from self-hosted evaluation

Nora should keep the open-source repo as the trust anchor. After that, the current public upgrade routes are:

1. **Stay self-hosted** if the repo and install flow already fit your team.
2. **Use rollout help / paid support** if you want the same product but need a faster path to first value.
3. **Use hosted evaluation / managed PaaS** if you want less self-managed infrastructure work.
4. **Use enterprise / custom deployment scoping** if the environment, rollout depth, or requirements need a more tailored path.

See also:
- [Commercial paths](COMMERCIAL_PATHS.md)
- [Deployment footprints](DEPLOYMENT_FOOTPRINTS.md)
- [Support paths](../SUPPORT.md)

## Security note

Do **not** paste secrets, API keys, or `.env` contents into Issues or Discussions.
