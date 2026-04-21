// @ts-nocheck
const crypto = require("crypto");
const DockerBackend = require("./docker");
const {
  buildDockerTelemetry,
  buildUnavailableTelemetry,
  DOCKER_CAPABILITIES,
  uptimeFromContainerInfo,
} = require("./telemetry");
const {
  getHermesDockerAgentImage,
} = require("../../../agent-runtime/lib/agentImages");
const {
  HERMES_DASHBOARD_PORT,
} = require("../../../agent-runtime/lib/contracts");
const {
  buildContainerBootstrap,
  toDockerLaunch,
} = require("../../../agent-runtime/lib/containerCommand");

const HERMES_RUNTIME_PORT = 8642;
const HERMES_HOME = "/opt/data";
const HERMES_LOG_DIR = `${HERMES_HOME}/logs`;
const HERMES_WORKSPACE = `${HERMES_HOME}/workspace`;
const HERMES_ENTRYPOINT = "/opt/hermes/docker/entrypoint.sh";
const CONTAINER_STDOUT_FD = "/proc/1/fd/1";
const CONTAINER_STDERR_FD = "/proc/1/fd/2";

function isMutableImageReference(imgName) {
  const ref = String(imgName || "").trim();
  if (!ref || ref.includes("@sha256:")) return false;

  const lastColon = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  const tag = lastColon > lastSlash ? ref.slice(lastColon + 1) : "latest";

  return ["latest", "main", "nightly", "edge", "canary"].includes(tag);
}

function buildHermesStartCommand() {
  return [
    "set -eu",
    `if [ -d ${HERMES_LOG_DIR} ]; then`,
    `  chown -R hermes:hermes ${HERMES_LOG_DIR} 2>/dev/null || true`,
    "else",
    `  mkdir -p ${HERMES_LOG_DIR}`,
    `  chown hermes:hermes ${HERMES_LOG_DIR} 2>/dev/null || true`,
    "fi",
    `nohup ${HERMES_ENTRYPOINT} dashboard --host 0.0.0.0 --insecure --no-open >> ${CONTAINER_STDOUT_FD} 2>> ${CONTAINER_STDERR_FD} &`,
    `exec ${HERMES_ENTRYPOINT} gateway run`,
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
            : `${stage} aborted`
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

class HermesBackend extends DockerBackend {
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
        console.warn(
          `[hermes] Failed to refresh ${imgName}; using cached image: ${error.message}`
        );
        return;
      }
    }

    await this._pullImage(imgName);
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
    } = config;
    const containerName = container_name || `hermes-agent-${id}`;
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
        `[hermes] Removing orphaned container ${info.Id.slice(0, 12)} (${containerName})`
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
    const envArray = Object.entries({
      ...(env || {}),
      HERMES_HOME,
      HOME: `${HERMES_HOME}/home`,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "0.0.0.0",
      API_SERVER_PORT: String(HERMES_RUNTIME_PORT),
      API_SERVER_KEY: apiServerKey,
      GATEWAY_HEALTH_URL: `http://127.0.0.1:${HERMES_RUNTIME_PORT}`,
      MESSAGING_CWD: HERMES_WORKSPACE,
      TERMINAL_CWD: HERMES_WORKSPACE,
    }).map(([key, value]) => `${key}=${value}`);

    const composeNetwork = await this._findComposeNetwork();
    const networkingConfig = composeNetwork
      ? { [composeNetwork]: {} }
      : undefined;
    const hostname = safeHostname(name || containerName, `hermes-${id}`);

    try {
      throwIfAborted(abortSignal, `hermes create for ${containerName}`);
      container = await this.docker.createContainer({
        Image: imgName,
        name: containerName,
        Hostname: hostname,
        Env: envArray,
        // Hermes needs a login bash so its image's /etc/profile (nvm / python
        // venv / CUDA env) is sourced; everything else here is identical to
        // the shared contract in agent-runtime/lib/containerCommand.ts.
        ...toDockerLaunch(
          buildContainerBootstrap(buildHermesStartCommand(), {
            shell: "/bin/bash",
            login: true,
          })
        ),
        WorkingDir: HERMES_HOME,
        ExposedPorts: {
          [`${HERMES_RUNTIME_PORT}/tcp`]: {},
          [`${HERMES_DASHBOARD_PORT}/tcp`]: {},
        },
        HostConfig: {
          NanoCpus: (vcpu || 2) * 1e9,
          Memory: (ram_mb || 2048) * 1024 * 1024,
          RestartPolicy: { Name: "unless-stopped" },
          Dns: ["8.8.8.8", "8.8.4.4", "1.1.1.1"],
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

      console.log(
        `[hermes] Container ${container.id} started at ${host}:${HERMES_RUNTIME_PORT}`
      );

      return {
        containerId: container.id,
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
          backendType: "hermes",
          running: false,
          uptime_seconds: uptimeFromContainerInfo(info),
          capabilities: DOCKER_CAPABILITIES,
        });
      }

      const stats = await container.stats({ stream: false });
      return buildDockerTelemetry({ stats, info, backendType: "hermes" });
    } catch {
      return buildUnavailableTelemetry({
        backendType: "hermes",
        running: Boolean(info?.State?.Running),
        uptime_seconds: uptimeFromContainerInfo(info),
        capabilities: DOCKER_CAPABILITIES,
      });
    }
  }
}

module.exports = HermesBackend;
