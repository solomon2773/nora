// @ts-nocheck
const crypto = require("crypto");
const DockerBackend = require("./docker");
const {
  buildDockerTelemetry,
  buildUnavailableTelemetry,
  DOCKER_CAPABILITIES,
  uptimeFromContainerInfo,
} = require("./telemetry");
const { getHermesDockerAgentImage } = require("../../../agent-runtime/lib/agentImages");
const { HERMES_DASHBOARD_PORT } = require("../../../agent-runtime/lib/contracts");
const { buildContainerBootstrap } = require("../../../agent-runtime/lib/containerCommand");
const {
  buildHermesRuntimeConfigBootstrapCommand,
} = require("../../../agent-runtime/lib/hermesRuntimeBootstrap");
const {
  deriveHermesDashboardBasicAuth,
} = require("../../../agent-runtime/lib/hermesDashboardAuth");

const HERMES_RUNTIME_PORT = 8642;
const HERMES_HOME = "/opt/data";
const HERMES_WORKSPACE = `${HERMES_HOME}/workspace`;
const HERMES_DASHBOARD_LOG = `${HERMES_HOME}/hermes-dashboard.log`;
const HERMES_BIN = "/opt/hermes/.venv/bin/hermes";
const DEFAULT_AGENT_PIDS_LIMIT = 512;
// The official Hermes image starts s6 as root, repairs mounted-state
// ownership, then drops its supervised services to the hermes user. Drop the
// default Docker capability set and add back only that lifecycle subset.
const HERMES_INIT_CAPABILITIES = Object.freeze([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "SETGID",
  "SETUID",
]);

function isMutableImageReference(imgName) {
  const ref = String(imgName || "").trim();
  if (!ref || ref.includes("@sha256:")) return false;

  const lastColon = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  const tag = lastColon > lastSlash ? ref.slice(lastColon + 1) : "latest";

  return ["latest", "main", "nightly", "edge", "canary"].includes(tag);
}

function buildHermesStartCommand() {
  // This runs as the container CMD, supervised directly by the image's PID-1
  // /init (s6-overlay). Do NOT re-exec /init here: a second s6 init launched as
  // a non-PID-1 child fatals with "s6-overlay-suexec: can only run as pid 1"
  // and exits the container within seconds, before the gateway can bind
  // port 8642 for the readiness probe (#297). Returning the runtime command
  // directly lets the image's PID-1 /init supervise it naturally.
  return [
    "set -eu",
    "if [ -r /opt/nora-managed-env/apply.sh ]; then . /opt/nora-managed-env/apply.sh; fi",
    buildHermesRuntimeConfigBootstrapCommand(),
    `HERMES_BIN="${HERMES_BIN}"`,
    '[ -x "$HERMES_BIN" ] || HERMES_BIN="$(command -v hermes)"',
    `nohup "$HERMES_BIN" dashboard --host 0.0.0.0 --no-open >> ${HERMES_DASHBOARD_LOG} 2>&1 &`,
    'exec "$HERMES_BIN" gateway run',
  ].join("\n");
}

function throwIfAborted(abortSignal, stage = "hermes create") {
  if (!abortSignal?.aborted) return;
  const reason =
    abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error(
          typeof abortSignal.reason === "string" && abortSignal.reason
            ? abortSignal.reason
            : `${stage} aborted`,
        );
  throw reason;
}

function safeHostname(name, fallback) {
  return (
    String(name || fallback || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63) || fallback
  );
}

function safeContainerName(prefix, name, id) {
  const suffix =
    String(id || Date.now().toString(36))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(-12) || "agent";
  const maxSlugLength = Math.max(8, 63 - prefix.length - suffix.length - 2);
  const slug =
    String(name || "agent")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, maxSlugLength) || "agent";
  return `${prefix}-${slug}-${suffix}`;
}

class HermesBackend extends DockerBackend {
  async _initialManagedEnvFileOwnership(_container) {
    // The official Hermes image runs its application user as 10000:10000.
    // Existing-container reconciliation still verifies the live passwd entry.
    return { uid: 10000, gid: 10000 };
  }

  async _managedEnvFileOwnership(container) {
    return this._containerUserOwnership(container, "hermes");
  }

  async _pullImage(imgName) {
    console.log(`[hermes] Pulling image ${imgName}...`);
    await new Promise((resolve, reject) => {
      this.docker.pull(imgName, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (followErr) => {
          if (followErr) return reject(followErr);
          console.log(`[hermes] Image ${imgName} pulled successfully`);
          resolve();
        });
      });
    });
  }

  async _ensureImage(imgName) {
    const mutableRef = isMutableImageReference(imgName);
    let hasLocalImage = false;

    try {
      await this.docker.getImage(imgName).inspect();
      hasLocalImage = true;
      console.log(`[hermes] Image ${imgName} already present`);
    } catch {
      hasLocalImage = false;
    }

    if (!mutableRef && hasLocalImage) {
      return;
    }

    if (mutableRef && hasLocalImage) {
      console.log(`[hermes] Refreshing mutable image tag ${imgName}`);
      try {
        await this._pullImage(imgName);
        return;
      } catch (error) {
        console.warn(`[hermes] Failed to refresh ${imgName}; using cached image: ${error.message}`);
        return;
      }
    }

    await this._pullImage(imgName);
  }

  // Host port mapping for the Hermes container. Local Hermes publishes the
  // runtime API (8642) and dashboard (9119) on the host interface named by
  // DOCKER_AGENT_BIND_IP (default loopback) so external desktop clients can
  // connect. The remote variant overrides this to bind 0.0.0.0 on the remote
  // host. Ports the caller did not allocate are simply omitted.
  _hermesPortBindings(config = {}) {
    const hostIp = this._publishedPortHostIp(config);
    const bindings = {};
    const runtimePort = Number(config?.gatewayHostPort);
    if (Number.isInteger(runtimePort) && runtimePort >= 1 && runtimePort <= 65535) {
      bindings[`${HERMES_RUNTIME_PORT}/tcp`] = [{ HostIp: hostIp, HostPort: String(runtimePort) }];
    }
    const dashboardPort = Number(config?.dashboardHostPort);
    if (Number.isInteger(dashboardPort) && dashboardPort >= 1 && dashboardPort <= 65535) {
      bindings[`${HERMES_DASHBOARD_PORT}/tcp`] = [
        { HostIp: hostIp, HostPort: String(dashboardPort) },
      ];
    }
    return Object.keys(bindings).length ? bindings : undefined;
  }

  async create(config) {
    const {
      id,
      name,
      image,
      vcpu,
      ram_mb,
      env,
      container_name,
      abortSignal,
      credentialManagedEnvNames = [],
    } = config;
    const containerName = container_name || safeContainerName("nora-hermes", name, id);
    const imgName = image || getHermesDockerAgentImage();
    let container = null;

    console.log(`[hermes] Creating container ${containerName} from ${imgName}`);
    throwIfAborted(abortSignal, `hermes create for ${containerName}`);
    await this._ensureImage(imgName);
    throwIfAborted(abortSignal, `hermes create for ${containerName}`);

    try {
      const existing = this.docker.getContainer(containerName);
      const info = await existing.inspect();
      console.log(
        `[hermes] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`,
      );
      try {
        await existing.stop({ t: 5 });
      } catch {
        // Already stopped.
      }
      await existing.remove({ force: true });
    } catch {
      // No existing container.
    }

    const apiServerKey = crypto.randomBytes(32).toString("hex");
    const dashboardAuth = deriveHermesDashboardBasicAuth(apiServerKey);
    const envArray = Object.entries({
      HERMES_HOME,
      HOME: `${HERMES_HOME}/home`,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: String(HERMES_RUNTIME_PORT),
      // Bake the gateway API key into the container environment so the
      // s6-supervised gateway service — which reads /run/s6/container_environment,
      // not the sourced managed-env file — inherits it on every boot, including
      // auth-reconcile restarts. Without this the gateway refuses to start with
      // "Refusing to start: API_SERVER_KEY is required" (#297).
      API_SERVER_KEY: apiServerKey,
      // Hermes fail-closed dashboard auth (basic-auth provider). Baked into the
      // container env so the s6-supervised dashboard reads it from
      // /run/s6/container_environment on every boot. The backend-api embed proxy
      // re-derives the identical credential from API_SERVER_KEY to log in on the
      // operator's behalf.
      HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboardAuth.username,
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboardAuth.password,
      HERMES_DASHBOARD_BASIC_AUTH_SECRET: dashboardAuth.secret,
      GATEWAY_HEALTH_URL: `http://127.0.0.1:${HERMES_RUNTIME_PORT}`,
      MESSAGING_CWD: HERMES_WORKSPACE,
      TERMINAL_CWD: HERMES_WORKSPACE,
    }).map(([key, value]) => `${key}=${value}`);

    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = composeNetwork ? { [composeNetwork]: {} } : undefined;
    const hostname = safeHostname(name || containerName, `hermes-${id}`);

    try {
      throwIfAborted(abortSignal, `hermes create for ${containerName}`);
      container = await this.docker.createContainer({
        Image: imgName,
        name: containerName,
        Hostname: hostname,
        Env: envArray,
        // Keep the image ENTRYPOINT intact so s6 init runs on current Hermes
        // images; main-wrapper then executes this bash command after bootstrap.
        Cmd: ["bash", "-lc", buildHermesStartCommand()],
        WorkingDir: HERMES_HOME,
        ExposedPorts: {
          [`${HERMES_RUNTIME_PORT}/tcp`]: {},
          [`${HERMES_DASHBOARD_PORT}/tcp`]: {},
        },
        HostConfig: {
          NanoCpus: (vcpu || 2) * 1e9,
          Memory: (ram_mb || 2048) * 1024 * 1024,
          RestartPolicy: { Name: "unless-stopped" },
          CapDrop: ["ALL"],
          CapAdd: [...HERMES_INIT_CAPABILITIES],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: DEFAULT_AGENT_PIDS_LIMIT,
          Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
          // Local Hermes publishes the runtime + dashboard ports to
          // DOCKER_AGENT_BIND_IP (see _hermesPortBindings above) in addition to
          // being reachable via the container IP on the shared compose network.
          PortBindings: this._hermesPortBindings(config),
        },
        NetworkingConfig: composeNetwork
          ? {
              EndpointsConfig: networkingConfig,
            }
          : undefined,
        Labels: {
          "nora.agent.id": String(id),
          "nora.agent.name": name || "",
          "nora.runtime.family": "hermes",
          "nora.runtime.port": String(HERMES_RUNTIME_PORT),
          "nora.dashboard.port": String(HERMES_DASHBOARD_PORT),
        },
      });

      await this.updateEnv(
        container.id,
        { ...(env || {}), API_SERVER_KEY: apiServerKey },
        {
          managedEnvNames: credentialManagedEnvNames,
          replaceManagedState: true,
          initializeManagedState: true,
          runtimeFamily: "hermes",
        },
      );
      throwIfAborted(abortSignal, `hermes start for ${containerName}`);
      await container.start();

      try {
        const bridgeNet = this.docker.getNetwork("bridge");
        await bridgeNet.connect({ Container: container.id });
        console.log("[hermes] Connected container to bridge network for internet access");
      } catch (error) {
        console.warn(`[hermes] Could not connect to bridge network: ${error.message}`);
      }

      const info = await container.inspect();
      let host = "localhost";
      if (composeNetwork && info.NetworkSettings?.Networks?.[composeNetwork]) {
        host = info.NetworkSettings.Networks[composeNetwork].IPAddress || "localhost";
      } else {
        host = info.NetworkSettings?.IPAddress || "localhost";
      }

      console.log(`[hermes] Container ${container.id} started at ${host}:${HERMES_RUNTIME_PORT}`);

      return {
        containerId: containerName,
        containerName,
        gatewayToken: apiServerKey,
        host,
        runtimeHost: host,
        runtimePort: HERMES_RUNTIME_PORT,
      };
    } catch (error) {
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }
      throw error;
    }
  }

  async stats(containerId) {
    let info = null;

    try {
      const container = this.docker.getContainer(containerId);
      info = await container.inspect();

      if (!info.State?.Running) {
        return buildUnavailableTelemetry({
          backendType: "docker",
          running: false,
          uptime_seconds: uptimeFromContainerInfo(info),
          capabilities: DOCKER_CAPABILITIES,
        });
      }

      const stats = await container.stats({ stream: false });
      return buildDockerTelemetry({ stats, info, backendType: "docker" });
    } catch {
      return buildUnavailableTelemetry({
        backendType: "docker",
        running: Boolean(info?.State?.Running),
        uptime_seconds: uptimeFromContainerInfo(info),
        capabilities: DOCKER_CAPABILITIES,
      });
    }
  }
}

module.exports = HermesBackend;
