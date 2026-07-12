// @ts-nocheck
const crypto = require("crypto");

function normalizeProviderConfig(config) {
  if (typeof config !== "string") return config ?? null;
  try {
    return JSON.parse(config);
  } catch {
    return config;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function buildEffectiveProviderState({ envVars = {}, defaultProvider = null } = {}) {
  const normalizedEnv = Object.fromEntries(
    Object.entries(envVars || {})
      .filter(([key, value]) => key && value != null && String(value) !== "")
      .map(([key, value]) => [key, String(value)]),
  );
  const normalizedProvider = defaultProvider
    ? {
        provider: defaultProvider.provider || null,
        model: defaultProvider.model || null,
        config: normalizeProviderConfig(defaultProvider.config),
      }
    : null;

  return canonicalize({
    env: normalizedEnv,
    defaultProvider: normalizedProvider,
  });
}

function fingerprintEffectiveProviderState(state = {}) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(buildEffectiveProviderState(state)))
    .digest("hex");
}

function shouldReconcileEffectiveProviderState(bootstrappedFingerprint, currentState = {}) {
  if (!bootstrappedFingerprint) return true;
  return fingerprintEffectiveProviderState(currentState) !== bootstrappedFingerprint;
}

function isBuiltInDemoActivation({ jobId, agentId, llmProviderId, defaultProvider } = {}) {
  const expectedJobId = agentId ? `demo-activation-${agentId}` : "";
  return Boolean(
    expectedJobId &&
    String(jobId || "") === expectedJobId &&
    llmProviderId &&
    defaultProvider?.provider === "demo",
  );
}

async function acquireDedicatedSessionLock({
  createClient,
  acquire,
  release,
  isAcquired = () => true,
  busyError = () => new Error("PostgreSQL advisory lock is already held"),
  onReleaseError,
  onCloseError,
} = {}) {
  if (typeof createClient !== "function") {
    throw new Error("createClient is required");
  }
  if (typeof acquire !== "function") {
    throw new Error("acquire is required");
  }
  if (typeof release !== "function") {
    throw new Error("release is required");
  }

  const client = createClient();
  if (!client || typeof client.connect !== "function" || typeof client.end !== "function") {
    throw new Error("createClient must return a connectable PostgreSQL client");
  }

  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await acquire(client);
    if (!isAcquired(result)) {
      const error = typeof busyError === "function" ? busyError(result) : busyError;
      throw error instanceof Error ? error : new Error(String(error || "Advisory lock is busy"));
    }
  } catch (error) {
    if (connected) {
      await client.end().catch((closeError) => onCloseError?.(closeError));
    }
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await release(client);
      } catch (error) {
        if (typeof onReleaseError === "function") {
          onReleaseError(error);
        } else {
          throw error;
        }
      } finally {
        await client.end().catch((closeError) => onCloseError?.(closeError));
      }
    },
  };
}

async function persistProvisionedRuntimeMetadata(
  queryable,
  {
    agentId,
    containerId,
    host,
    backendType,
    gatewayToken,
    containerName,
    gatewayHostPort,
    runtimeHost,
    runtimePort,
    gatewayHost,
    gatewayPort,
    image,
    runtimeFamily,
    deployTarget,
    executionTargetId,
    sandboxProfile,
    sandboxType,
    networkPolicyStatus,
    dashboardPort,
  } = {},
) {
  const result = await queryable.query(
    `UPDATE agents
        SET container_id = $2,
            host = $3,
            backend_type = $4,
            gateway_token = $5,
            container_name = COALESCE($6, container_name),
            gateway_host_port = $7,
            runtime_host = $8,
            runtime_port = $9,
            gateway_host = $10,
            gateway_port = $11,
            image = COALESCE($12, image),
            runtime_family = $13,
            deploy_target = $14,
            execution_target_id = $15,
            sandbox_profile = $16,
            sandbox_type = $17,
            network_policy_status = $18,
            dashboard_port = $19
      WHERE id = $1
        AND status = 'deploying'
        AND (container_id IS NULL OR container_id = $2)
      RETURNING id, container_id`,
    [
      agentId,
      containerId,
      host,
      backendType,
      gatewayToken,
      containerName || null,
      gatewayHostPort ? parseInt(gatewayHostPort, 10) : null,
      runtimeHost || null,
      runtimePort ? parseInt(runtimePort, 10) : null,
      gatewayHost || null,
      gatewayPort ? parseInt(gatewayPort, 10) : null,
      image || null,
      runtimeFamily,
      deployTarget,
      executionTargetId,
      sandboxProfile,
      sandboxType,
      networkPolicyStatus,
      dashboardPort ? parseInt(dashboardPort, 10) : null,
    ],
  );

  return {
    persisted: Boolean(result.rows[0]),
    containerId: result.rows[0]?.container_id || null,
  };
}

async function finalizeProvisionedDeployment(
  queryable,
  { agentId, containerId, name, backend, host } = {},
) {
  const ownsClient = typeof queryable?.connect === "function";
  const client = ownsClient ? await queryable.connect() : queryable;
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const agentUpdate = await client.query(
      `UPDATE agents
          SET status = 'running'
        WHERE id = $1
          AND status = 'deploying'
          AND container_id = $2
        RETURNING id`,
      [agentId, containerId],
    );
    if (!agentUpdate.rows[0]) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return { finalized: false, reason: "agent-missing-or-runtime-replaced" };
    }

    const deploymentUpdate = await client.query(
      `UPDATE deployments
          SET status = 'completed'
        WHERE agent_id = $1
          AND status = 'deploying'
        RETURNING agent_id`,
      [agentId],
    );
    if (!deploymentUpdate.rows[0]) {
      throw new Error(`Deployment ${agentId} was not in deploying state during finalization`);
    }

    await client.query("INSERT INTO events(type, message, metadata) VALUES($1, $2, $3)", [
      "agent_deployed",
      `Agent "${name}" is now running on ${backend}`,
      JSON.stringify({ agentId, containerId, host }),
    ]);
    await client.query("COMMIT");
    transactionOpen = false;
    return { finalized: true };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    if (ownsClient && typeof client?.release === "function") {
      client.release();
    }
  }
}

async function runProvisioningReadinessBarrier({
  checkReadiness,
  reconcileAuth,
  reconcileAndFinalize,
  finalize,
  failClosedOnReadinessFailure = false,
  onReadinessWarning,
} = {}) {
  if (typeof checkReadiness !== "function") {
    throw new Error("checkReadiness is required");
  }
  if (typeof finalize !== "function") {
    throw new Error("finalize is required");
  }

  const readiness = await checkReadiness();
  if (!readiness?.ok) {
    if (failClosedOnReadinessFailure) {
      const failureDetail =
        readiness?.runtime?.error ||
        readiness?.gateway?.error ||
        readiness?.runtime?.status ||
        readiness?.gateway?.status ||
        "unreachable";
      const error = new Error(`Initial runtime readiness failed (${failureDetail})`);
      error.code = "INITIAL_RUNTIME_READINESS_FAILED";
      error.readiness = readiness;
      throw error;
    }
    if (typeof onReadinessWarning === "function") {
      await onReadinessWarning(readiness);
    }
    return { status: "warning", readiness, reconciliation: null, finalization: null };
  }

  const settled =
    typeof reconcileAndFinalize === "function"
      ? await reconcileAndFinalize()
      : {
          reconciliation:
            typeof reconcileAuth === "function" ? await reconcileAuth() : { status: "skipped" },
          finalization: await finalize(),
        };
  const reconciliation = settled?.reconciliation || { status: "skipped" };
  const finalization = settled?.finalization || null;
  return {
    status: finalization?.finalized ? "running" : "canceled",
    readiness,
    reconciliation,
    finalization,
  };
}

async function reconcileProviderStateUntilStable({
  bootstrappedFingerprint,
  reconcile,
  readFingerprint,
  withMutationLock,
  finalize,
  maxPasses = 3,
} = {}) {
  if (typeof reconcile !== "function") {
    throw new Error("reconcile is required");
  }
  if (typeof readFingerprint !== "function") {
    throw new Error("readFingerprint is required");
  }
  if (typeof withMutationLock !== "function") {
    throw new Error("withMutationLock is required");
  }
  if (typeof finalize !== "function") {
    throw new Error("finalize is required");
  }

  const passLimit = Number.isFinite(Number(maxPasses))
    ? Math.max(1, Math.min(10, Number(maxPasses)))
    : 3;
  let appliedFingerprint = bootstrappedFingerprint || null;
  let reconciliation = { status: "skipped", reason: "unchanged" };

  for (let pass = 1; pass <= passLimit; pass += 1) {
    reconciliation = await reconcile(appliedFingerprint);
    const reconciledFingerprint = reconciliation?.providerFingerprint;
    if (!reconciledFingerprint) {
      throw new Error("provider reconciliation did not return a provider fingerprint");
    }
    appliedFingerprint = reconciledFingerprint;

    const verification = await withMutationLock(async () => {
      const currentFingerprint = await readFingerprint();
      if (!currentFingerprint) {
        throw new Error("provider verification did not return a provider fingerprint");
      }
      if (currentFingerprint !== appliedFingerprint) {
        return { stable: false, currentFingerprint };
      }
      return { stable: true, finalization: await finalize() };
    });

    if (verification?.stable) {
      return {
        reconciliation,
        finalization: verification.finalization,
        providerFingerprint: appliedFingerprint,
        passes: pass,
      };
    }
  }

  const error = new Error(
    `LLM provider state changed during ${passLimit} consecutive deployment finalization passes`,
  );
  error.code = "PROVIDER_STATE_UNSTABLE";
  throw error;
}

async function runRuntimeReconciliationBoundary({ mutations = [], restart, checkReadiness } = {}) {
  if (typeof restart !== "function") {
    throw new Error("restart is required");
  }
  if (typeof checkReadiness !== "function") {
    throw new Error("checkReadiness is required");
  }

  for (const mutation of mutations) {
    if (typeof mutation !== "function") {
      throw new Error("runtime reconciliation mutations must be functions");
    }
    await mutation();
  }
  await restart();
  return checkReadiness();
}

module.exports = {
  acquireDedicatedSessionLock,
  buildEffectiveProviderState,
  finalizeProvisionedDeployment,
  fingerprintEffectiveProviderState,
  isBuiltInDemoActivation,
  persistProvisionedRuntimeMetadata,
  reconcileProviderStateUntilStable,
  runProvisioningReadinessBarrier,
  runRuntimeReconciliationBoundary,
  shouldReconcileEffectiveProviderState,
};
