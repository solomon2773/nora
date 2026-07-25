// @ts-nocheck
// Remote Hermes backend — BYOC Phase B2.
//
// Runs the Hermes runtime on a remote machine's Docker daemon over SSH, the
// Hermes analogue of RemoteDockerBackend (OpenClaw). It extends HermesBackend
// so all Hermes-specific bootstrap/image/lifecycle logic is inherited, and
// changes only what differs on a remote standalone host:
//   1. the dockerode client talks to the remote daemon over SSH;
//   2. no Nora compose network (default bridge);
//   3. the Hermes RUNTIME port (8642 — the API the post-deploy readiness probe
//      hits at /health) AND the dashboard port (9119 — the embed UI) are both
//      PUBLISHED on the remote host, each on its own worker-allocated host port
//      (local Hermes publishes nothing — it's reached via the container IP on the
//      shared compose network, which isn't possible across SSH);
//   4. create() advertises the remote machine's address + the published runtime
//      and dashboard ports so readiness passes, the control plane targets the
//      remote host, and the dashboard embed proxy resolves the right address.
//
// The dashboard embed proxy enforces the SSRF allowlist (closed in #207/#208);
// a remote agent's own registered host is owner-scoped-allowed there.

const HermesBackend = require("./hermes");
const { buildRemoteDockerOptions } = require("./remote-docker");
const {
  HERMES_RUNTIME_PORT,
  HERMES_DASHBOARD_PORT,
} = require("../../../agent-runtime/lib/contracts");

class RemoteHermesBackend extends HermesBackend {
  constructor(profile = {}) {
    super();
    this.profile = profile || {};
    this.executionTargetId = String(this.profile.executionTargetId || "")
      .trim()
      .toLowerCase();
    if (!this.executionTargetId.startsWith("remote:")) {
      throw new Error("Remote Hermes backend requires a registered remote host profile.");
    }
    if (!this.profile.sshHost || !this.profile.sshUser) {
      throw new Error(
        `Remote host ${this.profile.label || this.executionTargetId} is missing SSH connection details.`,
      );
    }
    const hasCredential =
      this.profile.sshAuthMode === "password"
        ? Boolean(this.profile.sshPassword)
        : Boolean(this.profile.sshPrivateKey);
    if (!hasCredential) {
      throw new Error(
        `Remote host ${this.profile.label || this.executionTargetId} is missing its SSH ` +
          `${this.profile.sshAuthMode === "password" ? "password" : "private key"}.`,
      );
    }
    // Reuse the dockerode constructor the parent resolved, pointed at the remote
    // daemon over SSH. dockerode is lazy, so the local client opened nothing.
    const Docker = this.docker.constructor;
    this.docker = new Docker(buildRemoteDockerOptions(this.profile));
    this._composeNetwork = null;
  }

  async _findComposeNetwork() {
    return null;
  }

  // Publish the Hermes RUNTIME port (readiness/API) and DASHBOARD port (embed UI)
  // on their worker-allocated host ports so both are reachable across the network
  // ({runtime_host}:{runtime_port}/health for readiness; the dashboard via its own
  // published port). A missing/invalid allocation simply omits that binding.
  _hermesPortBindings(config) {
    const bindings = {};
    const runtimePort = Number(config?.gatewayHostPort);
    if (Number.isInteger(runtimePort) && runtimePort >= 1 && runtimePort <= 65535) {
      bindings[`${HERMES_RUNTIME_PORT}/tcp`] = [
        { HostIp: "0.0.0.0", HostPort: String(runtimePort) },
      ];
    }
    const dashboardPort = Number(config?.dashboardHostPort);
    if (Number.isInteger(dashboardPort) && dashboardPort >= 1 && dashboardPort <= 65535) {
      bindings[`${HERMES_DASHBOARD_PORT}/tcp`] = [
        { HostIp: "0.0.0.0", HostPort: String(dashboardPort) },
      ];
    }
    return Object.keys(bindings).length ? bindings : undefined;
  }

  async create(config = {}) {
    const result = await super.create(config);
    // Advertise the remote machine's address + the published runtime and dashboard
    // ports so the control plane targets the remote host instead of the container's
    // internal (unreachable) compose IP, readiness probes the right address, and the
    // dashboard embed proxy resolves {runtime_host}:{dashboard_port}.
    const advertisedHost = this.profile.gatewayHost || this.profile.sshHost;
    const publishedRuntimePort = Number(config?.gatewayHostPort) || null;
    const publishedDashboardPort = Number(config?.dashboardHostPort) || null;
    return {
      ...result,
      host: advertisedHost,
      runtimeHost: advertisedHost,
      runtimePort: publishedRuntimePort || result.runtimePort,
      dashboardPort: publishedDashboardPort,
    };
  }
}

module.exports = RemoteHermesBackend;
