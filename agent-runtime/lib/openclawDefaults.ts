// @ts-nocheck

// Nora validates each supported OpenClaw release before making it the default.
// Keep this exact: floating `latest` installs can change the Gateway protocol or
// first-run behavior without a Nora release, which makes activation and rollback
// evidence non-reproducible. Operators can still override the package spec with
// OPENCLAW_DOCKER_PACKAGE (or PROXMOX_OPENCLAW_PACKAGE for that adapter).
const DEFAULT_OPENCLAW_VERSION = "2026.6.11";
const DEFAULT_OPENCLAW_PACKAGE_SPEC = `openclaw@${DEFAULT_OPENCLAW_VERSION}`;

module.exports = {
  DEFAULT_OPENCLAW_PACKAGE_SPEC,
  DEFAULT_OPENCLAW_VERSION,
};
