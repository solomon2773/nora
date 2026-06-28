// @ts-nocheck
// Remote NemoClaw backend.
//
// Runs the local Docker NemoClaw adapter against a registered remote Docker
// daemon over SSH. It keeps the NemoClaw-specific OpenShell bootstrap/policy
// path from NemoClawBackend, but disables compose-network discovery and
// advertises the remote host's published gateway port back to the control plane.

const NemoClawBackend = require("./nemoclaw");
const { buildRemoteDockerOptions } = require("./remote-docker");

class RemoteNemoClawBackend extends NemoClawBackend {
  constructor(profile = {}) {
    super();
    this.profile = profile || {};
    this.executionTargetId = String(this.profile.executionTargetId || "")
      .trim()
      .toLowerCase();
    if (!this.executionTargetId.startsWith("remote:")) {
      throw new Error("Remote NemoClaw backend requires a registered remote host profile.");
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

    const Docker = this.docker.constructor;
    this.docker = new Docker(buildRemoteDockerOptions(this.profile));
    this._composeNetwork = null;
  }

  async _findComposeNetwork() {
    return null;
  }

  async create(config = {}) {
    const result = await super.create(config);
    const advertisedHost = this.profile.gatewayHost || this.profile.sshHost;
    const publishedGatewayPort =
      Number(result.gatewayHostPort) || Number(config.gatewayHostPort) || null;
    const publishedRuntimePort =
      Number(result.runtimeHostPort) || Number(config.runtimeHostPort) || null;
    return {
      ...result,
      host: advertisedHost,
      runtimeHost: advertisedHost,
      runtimePort: publishedRuntimePort,
      gatewayHost: advertisedHost,
      gatewayPort: publishedGatewayPort,
    };
  }
}

module.exports = RemoteNemoClawBackend;
