// @ts-nocheck
// Remote Docker backend — BYOC Phase A (A2b).
//
// Runs the EXACT same OpenClaw orchestration as the local DockerBackend, but
// against a remote machine's Docker daemon reached over SSH. dockerode 5 +
// docker-modem 5 + ssh2 establish the connection programmatically (the modem
// runs `docker system dial-stdio` over an ssh2 session — no shell ssh binary),
// so every container/image/volume/exec/putArchive call transfers transparently.
//
// We therefore subclass DockerBackend and change only what differs on a remote
// standalone host:
//   1. the dockerode client points at the remote daemon over SSH;
//   2. there is no Nora compose network to join (use the default bridge +
//      published host port);
//   3. create() advertises the remote machine's reachable gateway address so
//      the control plane's resolveGatewayAddress targets the remote host, not
//      host.docker.internal.
//
// The reusable bootstrap generators, tar injection, image build/pull, and
// lifecycle methods are all inherited unchanged.

const DockerBackend = require("./docker");

const DEFAULT_SSH_PORT = 22;

// Translate a remote_hosts profile into dockerode SSH connection options.
function buildRemoteDockerOptions(profile = {}) {
  const sshOptions = {};
  if (profile.sshAuthMode === "password") {
    if (profile.sshPassword) sshOptions.password = profile.sshPassword;
  } else {
    if (profile.sshPrivateKey) sshOptions.privateKey = Buffer.from(profile.sshPrivateKey);
    if (profile.sshPassphrase) sshOptions.passphrase = profile.sshPassphrase;
  }
  // Host-key pinning (MITM protection): the connection test pins the host key
  // (TOFU). When a pin exists, reject any connection presenting a different key.
  // Without a pin (host registered before pinning, or test never run) we accept
  // trust-on-first-use so existing deployments don't break.
  const expectedHostKey = typeof profile.sshHostKey === "string" ? profile.sshHostKey.trim() : "";
  sshOptions.hostVerifier = (key) => {
    if (!expectedHostKey) return true;
    const presented = Buffer.isBuffer(key) ? key.toString("base64") : String(key || "");
    return presented === expectedHostKey;
  };
  return {
    protocol: "ssh",
    host: profile.sshHost,
    port: profile.sshPort || DEFAULT_SSH_PORT,
    username: profile.sshUser,
    sshOptions,
  };
}

class RemoteDockerBackend extends DockerBackend {
  constructor(profile = {}) {
    // The parent constructor wires this.docker to the LOCAL socket; we replace
    // it below with an SSH-backed client before any operation runs.
    super();
    this.profile = profile || {};
    this.executionTargetId = String(this.profile.executionTargetId || "")
      .trim()
      .toLowerCase();
    if (!this.executionTargetId.startsWith("remote:")) {
      throw new Error("Remote Docker backend requires a registered remote host profile.");
    }
    if (!this.profile.sshHost || !this.profile.sshUser) {
      throw new Error(
        `Remote host ${this.profile.label || this.executionTargetId} is missing SSH connection details.`,
      );
    }
    // Require the credential for the selected auth mode. Without this, an empty
    // sshOptions would let docker-modem/ssh2 silently fall back to ambient
    // credentials (the worker's own ~/.ssh key or SSH agent) and authenticate
    // as the wrong identity — so fail loudly instead.
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
    // Reuse the exact dockerode constructor the parent resolved, but connect to
    // the remote daemon over SSH instead of /var/run/docker.sock. dockerode is
    // lazy — the local-socket client the parent just built opens no connection,
    // so replacing it here leaks nothing.
    const Docker = this.docker.constructor;
    this.docker = new Docker(buildRemoteDockerOptions(this.profile));
    // A remote standalone host has no Nora compose network — never discover one.
    this._composeNetwork = null;
  }

  // Remote daemons are standalone: skip compose-network discovery so create()
  // falls back to the default bridge network and a published host port.
  async _findComposeNetwork() {
    return null;
  }

  async create(config = {}) {
    const result = await super.create(config);
    // The gateway port is published on the REMOTE host's interface, so point
    // the control plane at the host's advertised address + that published port
    // (resolveGatewayAddress prefers gateway_host + gateway_port). Without this
    // it would fall back to host.docker.internal, which is the wrong machine.
    const gatewayHost = this.profile.gatewayHost || this.profile.sshHost;
    const runtimeHostPort =
      Number(result.runtimeHostPort) || Number(config.runtimeHostPort) || null;
    return {
      ...result,
      gatewayHost,
      gatewayPort: result.gatewayHostPort || null,
      runtimeHost: gatewayHost,
      runtimePort: runtimeHostPort || result.runtimePort || null,
    };
  }
}

module.exports = RemoteDockerBackend;
module.exports.buildRemoteDockerOptions = buildRemoteDockerOptions;
