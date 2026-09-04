// @ts-nocheck
const mockDb = { query: jest.fn() };
const mockContainerManager = { status: jest.fn() };
const mockCollectTelemetry = jest.fn();

jest.mock("../db", () => mockDb);
jest.mock("../containerManager", () => mockContainerManager);
jest.mock("../agentTelemetry", () => ({
  collectAgentTelemetrySample: mockCollectTelemetry,
}));
// Mocked so backgroundTasks doesn't pull in the real gatewayProxy chain; the
// external reconcile tests inject their own healthProbe anyway.
jest.mock("../externalHealth", () => ({ probeExternalAgentHealth: jest.fn() }));

const {
  collectBackgroundTelemetry,
  reconcileBackgroundAgentStatuses,
  reconcileExternalAgentStatuses,
} = require("../backgroundTasks");

describe("background tasks", () => {
  beforeEach(() => {
    mockDb.query.mockReset();
    mockContainerManager.status.mockReset();
    mockCollectTelemetry.mockReset();
  });

  it("reconciles supported non-docker backends through containerManager status", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-k8s-1",
          container_id: "oclaw-agent-123",
          backend_type: "k8s",
          status: "running",
        },
      ],
    });
    mockContainerManager.status.mockResolvedValueOnce({ running: true });

    await reconcileBackgroundAgentStatuses();

    expect(mockContainerManager.status).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-k8s-1",
        backend_type: "k8s",
        container_id: "oclaw-agent-123",
      }),
    );
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it("marks unreachable warning agents as stopped", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-err-1",
          container_id: "runtime-1",
          backend_type: "k8s",
          status: "warning",
        },
      ],
    });
    mockContainerManager.status.mockRejectedValueOnce(new Error("unreachable"));
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    await reconcileBackgroundAgentStatuses();

    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
      ["stopped", "agent-err-1", "warning"],
    );
  });

  it.each([
    "REMOTE_HOST_ACCESS_REVOKED",
    "REMOTE_HOST_RETEST_REQUIRED",
    "REMOTE_HOST_AUTH_CHECK_FAILED",
  ])("preserves status when Remote Docker inspection fails with %s", async (code) => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          id: "agent-revoked-1",
          user_id: "former-grantee",
          container_id: "runtime-1",
          backend_type: "remote-docker",
          deploy_target: "remote-docker",
          execution_target_id: "remote:shared-host",
          status: "running",
        },
      ],
    });
    mockContainerManager.status.mockRejectedValueOnce(
      Object.assign(new Error("remote host state is unknown"), { code }),
    );

    await reconcileBackgroundAgentStatuses();

    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it.each(["provider_auth_reconciliation_pending", "provider_auth_reconciliation_failed"])(
    "does not promote a provider-auth held runtime back to running (%s)",
    async (pausedReason) => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "agent-quarantined-1",
            container_id: "runtime-1",
            backend_type: "docker",
            status: "error",
            paused_reason: pausedReason,
          },
        ],
      });

      await reconcileBackgroundAgentStatuses();

      expect(mockContainerManager.status).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    },
  );

  it("collects telemetry for running agents and prunes old samples", async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "agent-run-1",
            container_id: "ctr-1",
            backend_type: "docker",
            status: "running",
            host: "10.0.0.10",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    mockCollectTelemetry.mockResolvedValueOnce(undefined);

    await collectBackgroundTelemetry();

    expect(mockCollectTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-run-1",
        backend_type: "docker",
      }),
    );
    expect(mockDb.query).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM container_stats WHERE recorded_at < NOW() - INTERVAL '7 days'",
    );
  });

  describe("external runtime reconciliation", () => {
    it("only queries external agents (not provisioned ones)", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      await reconcileExternalAgentStatuses({ healthProbe: jest.fn() });
      expect(mockDb.query.mock.calls[0][0]).toMatch(/deploy_target = 'external'/);
    });

    it("recovers a reachable external agent to running", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "ext-1", status: "stopped", deploy_target: "external" }],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      const healthProbe = jest.fn().mockResolvedValue({ running: true });

      await reconcileExternalAgentStatuses({ healthProbe });

      expect(healthProbe).toHaveBeenCalledWith(expect.objectContaining({ id: "ext-1" }));
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["running", "ext-1", "stopped"],
      );
    });

    it("marks an unreachable external agent as stopped", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "ext-2", status: "running", deploy_target: "external" }],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      const healthProbe = jest.fn().mockResolvedValue({ running: false });

      await reconcileExternalAgentStatuses({ healthProbe });

      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["stopped", "ext-2", "running"],
      );
    });

    it("treats a probe that throws as not running (best-effort)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "ext-3", status: "running", deploy_target: "external" }],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      const healthProbe = jest.fn().mockRejectedValue(new Error("boom"));

      await reconcileExternalAgentStatuses({ healthProbe });

      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["stopped", "ext-3", "running"],
      );
    });

    it("leaves an unchanged status alone (no UPDATE)", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "ext-4", status: "running", deploy_target: "external" }],
      });
      const healthProbe = jest.fn().mockResolvedValue({ running: true });

      await reconcileExternalAgentStatuses({ healthProbe });

      expect(mockDb.query).toHaveBeenCalledTimes(1); // only the SELECT
    });
  });
  describe("concurrent-deploy safety (status CAS)", () => {
    it("guards the container reconcile UPDATE with the status it observed", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "agent-race-1",
            container_id: "nora-hermes-agent-race-1",
            backend_type: "docker",
            runtime_family: "hermes",
            status: "running",
          },
        ],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockContainerManager.status.mockResolvedValueOnce({ running: false });

      await reconcileBackgroundAgentStatuses();

      // The row may have moved to 'deploying' between the snapshot SELECT and
      // this write. Without the status predicate the sweep silently clobbers
      // the deploy lifecycle, which makes the provisioner destroy the agent's
      // data volume as an "orphan".
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["stopped", "agent-race-1", "running"],
      );
    });

    it("guards the reconcile UPDATE on the probe-failure branch too", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: "agent-race-2",
            container_id: "runtime-2",
            backend_type: "docker",
            status: "running",
          },
        ],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      mockContainerManager.status.mockRejectedValueOnce(new Error("docker unreachable"));

      await reconcileBackgroundAgentStatuses();

      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["stopped", "agent-race-2", "running"],
      );
    });

    it("guards the external reconcile UPDATE with the status it observed", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: "ext-race", status: "stopped", deploy_target: "external" }],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      const healthProbe = jest.fn().mockResolvedValue({ running: true });

      await reconcileExternalAgentStatuses({ healthProbe });

      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        "UPDATE agents SET status = $1 WHERE id = $2 AND status = $3",
        ["running", "ext-race", "stopped"],
      );
    });
  });
});
