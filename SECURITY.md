# Nora Security Policy

Security reports need a private path. If you think you found a vulnerability in Nora, do not open a public GitHub issue, discussion, or pull request.

## Supported Versions

Nora is still evolving quickly. Security fixes are prioritized for the latest public code on the default repository branch and any current deployment guidance reflected in the root docs.

Older snapshots, stale forks, and heavily modified self-hosted deployments may require you to rebase or upgrade before a fix can be applied cleanly.

## How to Report a Vulnerability

Use GitHub's [private vulnerability report form](https://github.com/solomon2773/nora/security/advisories/new) to disclose vulnerabilities to the Nora maintainers. Do not use a public issue, discussion, or pull request.

When possible, include:

- a short description of the issue
- the affected component or path
- reproduction steps or a proof of concept
- impact assessment
- any suggested mitigation
- whether the issue is already known to anyone else

The report and follow-up discussion remain private between the reporter and repository maintainers until coordinated disclosure.

## What Not To Do

- Do not post exploit details in public issues or discussions.
- Do not include secrets, production credentials, API keys, or private customer data in a report.
- Do not run destructive testing against infrastructure you do not own or have explicit permission to test.

## Response Expectations

The goal is to:

1. acknowledge a credible report promptly
2. reproduce and assess severity
3. develop and validate a fix or mitigation
4. coordinate disclosure after affected users have a reasonable path to update

Response times are best-effort and may vary depending on report quality, impact, and maintainer availability.

## Disclosure Guidance

Please give maintainers a reasonable window to investigate and ship a fix before public disclosure. Coordinated disclosure improves the odds that self-hosted operators can patch safely.

## Scope Notes

This policy covers vulnerabilities in the public Nora repository, including:

- the web surfaces
- the backend API
- provisioning workers
- runtime integration code
- public install and deployment scripts
- documentation that could lead to unsafe deployment defaults

If an issue only affects your own infrastructure, custom integrations, or modified deployment topology, the maintainer may still help narrow it down, but remediation may remain your responsibility.
