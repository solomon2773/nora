#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if ! docker compose ps --status running --services | grep -qx "worker-provisioner"; then
  echo "worker-provisioner must be running with the Proxmox environment configured" >&2
  echo "Start Nora first, then rerun this smoke from the repository checkout." >&2
  exit 1
fi

PROXMOX_EXEC_ENV_VARS=(
  NODE_ENV
  ENABLED_BACKENDS
  ENABLED_RUNTIME_FAMILIES
  ENABLED_SANDBOX_PROFILES
  PROXMOX_API_URL
  PROXMOX_TOKEN_ID
  PROXMOX_TOKEN_SECRET
  PROXMOX_VERIFY_TLS
  PROXMOX_CA_CERT
  PROXMOX_CA_CERT_PATH
  PROXMOX_ALLOW_INSECURE_HTTP
  PROXMOX_NODE
  PROXMOX_TEMPLATE
  PROXMOX_HERMES_TEMPLATE
  PROXMOX_ROOTFS_STORAGE
  PROXMOX_BRIDGE
  PROXMOX_SSH_HOST
  PROXMOX_SSH_USER
  PROXMOX_SSH_PORT
  PROXMOX_SSH_PRIVATE_KEY
  PROXMOX_SSH_PRIVATE_KEY_PATH
  PROXMOX_SSH_PRIVATE_KEY_PASSPHRASE
  PROXMOX_SSH_PASSWORD
  PROXMOX_SSH_HOST_FINGERPRINT
  PROXMOX_SSH_INSECURE_ACCEPT_HOST_KEY
  PROXMOX_PCT_COMMAND
  PROXMOX_SUDO
  PROXMOX_OFFLINE_STAGE_COMMAND
  PROXMOX_NODE_MAJOR
  PROXMOX_OPENCLAW_PACKAGE
  PROXMOX_HERMES_BIN
  PROXMOX_HERMES_ENABLE_INSECURE_DASHBOARD
  PROXMOX_SMOKE_RUNTIME_FAMILIES
  PROXMOX_SMOKE_KEEP_ON_FAILURE
  PROXMOX_SMOKE_VCPU
  PROXMOX_SMOKE_RAM_MB
  PROXMOX_SMOKE_DISK_GB
)

compose_exec_args=(-T)
for env_name in "${PROXMOX_EXEC_ENV_VARS[@]}"; do
  if [[ -v $env_name ]]; then
    # Passing the name only keeps secret values out of the local Docker CLI argv.
    compose_exec_args+=(--env "$env_name")
  fi
done

docker compose exec "${compose_exec_args[@]}" worker-provisioner sh -lc '
  smoke_dir="$(mktemp -d /tmp/nora-proxmox-smoke.XXXXXX)"
  smoke_file="$smoke_dir/smoke.ts"
  trap '\''rm -rf "$smoke_dir"'\'' EXIT
  cat > "$smoke_file"
  ./node_modules/.bin/tsx "$smoke_file"
' <<'NORA_PROXMOX_SMOKE'
const ProxmoxBackend = require("/app/backends/proxmox");
const { waitForAgentReadiness } = require("/app/healthChecks");
const { getBackendStatus } = require("/agent-runtime/lib/backendCatalog");

const runtimeFamilies = String(process.env.PROXMOX_SMOKE_RUNTIME_FAMILIES || "openclaw")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const keepOnFailure = process.env.PROXMOX_SMOKE_KEEP_ON_FAILURE === "true";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const catalogStatus = getBackendStatus("proxmox");
assert(catalogStatus.enabled, "Proxmox is not enabled in ENABLED_BACKENDS");
assert(
  catalogStatus.available,
  `Proxmox catalog preflight failed: ${catalogStatus.issue || "target unavailable"}`,
);
assert(
  catalogStatus.maturityTier === "experimental",
  `Proxmox must remain experimental until the real-hardware promotion gate is satisfied; received ${catalogStatus.maturityTier}`,
);

async function collectExec(result, timeoutMs = 30000) {
  assert(result?.stream && result?.exec, "Proxmox exec did not return a stream and inspect handle");
  const chunks = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      result.stream.destroy();
      reject(new Error(`Proxmox exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    result.stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    result.stream.on("end", finish);
    result.stream.on("close", finish);
    result.stream.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
  const state = await result.exec.inspect();
  const output = Buffer.concat(chunks).toString("utf8");
  if (state?.Running !== false || !Number.isInteger(state?.ExitCode)) {
    throw new Error("Proxmox exec output ended without a confirmed remote command exit status");
  }
  if (state.ExitCode !== 0) {
    throw new Error(output.trim() || `Proxmox exec exited with ${state?.ExitCode}`);
  }
  return output;
}

async function waitUntilReady(runtimeFamily, result) {
  const readiness = await waitForAgentReadiness({
    host: result.host,
    runtimeHost: result.runtimeHost || result.host,
    runtimePort: result.runtimePort,
    gatewayHost: result.gatewayHost || null,
    gatewayHostPort: result.gatewayHostPort || null,
    gatewayPort: result.gatewayPort || null,
    checkGateway: runtimeFamily !== "hermes",
  });
  if (!readiness.ok) {
    throw new Error(
      `Readiness failed: ${readiness.runtime?.error || readiness.gateway?.error || "unreachable"}`,
    );
  }
}

async function runCell(runtimeFamily) {
  if (!["openclaw", "hermes"].includes(runtimeFamily)) {
    throw new Error(
      `Unsupported smoke runtime ${runtimeFamily}; Proxmox currently validates openclaw and hermes only`,
    );
  }

  const backend = new ProxmoxBackend();
  backend._assertConfigured();
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `proxmox-smoke-${runtimeFamily}-${suffix}`;
  const ownershipOptions = { agentId };
  let result = null;
  let destroyed = false;

  console.log(`[proxmox-smoke] creating ${runtimeFamily} cell ${agentId}`);
  try {
    result = await backend.create({
      id: agentId,
      name: `Nora Proxmox Smoke ${runtimeFamily}`,
      container_name: `nora-smoke-${runtimeFamily}-${suffix}`,
      vcpu: Number(process.env.PROXMOX_SMOKE_VCPU || 2),
      ram_mb: Number(process.env.PROXMOX_SMOKE_RAM_MB || 2048),
      disk_gb: Number(process.env.PROXMOX_SMOKE_DISK_GB || 20),
      runtimeFamily,
      sandboxProfile: "standard",
      templatePayload: {},
      env: {
        AGENT_ID: agentId,
        AGENT_NAME: `Nora Proxmox Smoke ${runtimeFamily}`,
      },
    });
    assert(/^\d+$/.test(result.containerId), "create did not return a numeric Proxmox VMID");

    const live = await backend.status(result.containerId, ownershipOptions);
    assert(live.running, "new Proxmox LXC is not running");
    await waitUntilReady(runtimeFamily, result);

    const marker = `nora-proxmox-${suffix}`;
    const commandOutput = await collectExec(
      await backend.exec(result.containerId, {
        cmd: ["/bin/sh", "-lc", `printf %s ${JSON.stringify(marker)}`],
        tty: false,
        agentId,
      }),
    );
    assert(commandOutput === marker, `exec output mismatch: ${JSON.stringify(commandOutput)}`);

    await backend.updateEnv(
      result.containerId,
      { NORA_PROXMOX_SMOKE_MARKER: marker },
      { runtimeFamily, agentId },
    );
    const restarted = await backend.restart(result.containerId, ownershipOptions);
    result = { ...result, ...(restarted || {}) };
    await waitUntilReady(runtimeFamily, result);

    const serviceName = runtimeFamily === "hermes" ? "nora-hermes.service" : "nora-openclaw.service";
    const envOutput = await collectExec(
      await backend.exec(result.containerId, {
        cmd: [
          "/bin/sh",
          "-lc",
          `pid="$(systemctl show -p MainPID --value ${serviceName})"; tr '\\0' '\\n' < "/proc/$pid/environ" | grep -Fx ${JSON.stringify(`NORA_PROXMOX_SMOKE_MARKER=${marker}`)}`,
        ],
        tty: false,
        agentId,
      }),
    );
    assert(envOutput.trim() === `NORA_PROXMOX_SMOKE_MARKER=${marker}`, "env rotation did not survive restart");

    const logStream = await backend.logs(result.containerId, {
      follow: false,
      tail: 50,
      agentId,
    });
    await new Promise((resolve, reject) => {
      logStream.resume();
      logStream.on("end", resolve);
      logStream.on("error", reject);
    });

    await backend.stop(result.containerId, ownershipOptions);
    assert(
      !(await backend.status(result.containerId, ownershipOptions)).running,
      "stop did not halt the LXC",
    );
    const offlineMarker = `${marker}-offline`;
    await backend.updateEnv(
      result.containerId,
      { NORA_PROXMOX_SMOKE_MARKER: offlineMarker },
      {
        runtimeFamily,
        agentId,
        managedEnvNames: ["NORA_PROXMOX_SMOKE_MARKER"],
        replaceManagedState: true,
      },
    );
    const started = await backend.start(result.containerId, ownershipOptions);
    result = { ...result, ...(started || {}) };
    await waitUntilReady(runtimeFamily, result);
    const offlineEnvOutput = await collectExec(
      await backend.exec(result.containerId, {
        cmd: [
          "/bin/sh",
          "-lc",
          `pid="$(systemctl show -p MainPID --value ${serviceName})"; tr '\0' '\n' < "/proc/$pid/environ" | grep -Fx ${JSON.stringify(`NORA_PROXMOX_SMOKE_MARKER=${offlineMarker}`)}`,
        ],
        tty: false,
        agentId,
      }),
    );
    assert(
      offlineEnvOutput.trim() === `NORA_PROXMOX_SMOKE_MARKER=${offlineMarker}`,
      "stopped-LXC env replacement did not apply before start",
    );

    await backend.destroy(result.containerId, ownershipOptions);
    destroyed = true;
    assert(
      !(await backend.status(result.containerId, ownershipOptions)).running,
      "destroy left the LXC present",
    );
    console.log(`[proxmox-smoke] ${runtimeFamily} lifecycle passed (vmid=${result.containerId})`);
  } catch (error) {
    if (result?.containerId && keepOnFailure) {
      console.error(
        `[proxmox-smoke] preserving failed ${runtimeFamily} LXC vmid=${result.containerId} because PROXMOX_SMOKE_KEEP_ON_FAILURE=true`,
      );
    }
    throw error;
  } finally {
    if (result?.containerId && !destroyed && !keepOnFailure) {
      try {
        await backend.destroy(result.containerId, ownershipOptions);
      } catch (cleanupError) {
        console.error(
          `[proxmox-smoke] cleanup failed for vmid=${result.containerId}: ${cleanupError.message}`,
        );
      }
    }
  }
}

(async () => {
  for (const runtimeFamily of runtimeFamilies) {
    await runCell(runtimeFamily);
  }
  console.log(`[proxmox-smoke] passed ${runtimeFamilies.join(", ")}`);
})().catch((error) => {
  console.error(`[proxmox-smoke] failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
NORA_PROXMOX_SMOKE
