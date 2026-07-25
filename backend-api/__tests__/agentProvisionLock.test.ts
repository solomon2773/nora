// @ts-nocheck

const mockClient = {
  connect: jest.fn(),
  query: jest.fn(),
  end: jest.fn(),
};
const mockClientConstructor = jest.fn(() => mockClient);
const mockBuildPostgresConfig = jest.fn(() => ({}));

jest.mock("pg", () => ({ Client: mockClientConstructor }));
jest.mock("../lib/connectionConfig", () => ({
  buildPostgresConfig: mockBuildPostgresConfig,
}));

const {
  acquireAgentProvisionLock,
  advisoryLockKeyForAgent,
  buildReplacementDeploymentJob,
  enqueueReplacementDeployment,
} = require("../agentProvisionLock");

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.query.mockResolvedValue({ rows: [{ locked: true }] });
  mockClient.end.mockResolvedValue(undefined);
});

it("uses the same signed FNV-1a advisory key as the provisioner", () => {
  expect(advisoryLockKeyForAgent("agent-1").toString()).toBe("-7187856561226066112");
  expect(advisoryLockKeyForAgent("123").toString()).toBe("5003431119771845851");
});

it("holds a dedicated session lock until release", async () => {
  const lock = await acquireAgentProvisionLock("agent-1", {
    applicationName: "nora-test-agent-lock",
    timeoutMs: 10,
  });

  expect(mockClient.connect).toHaveBeenCalledTimes(1);
  expect(mockClient.query).toHaveBeenNthCalledWith(1, "SELECT pg_try_advisory_lock($1) AS locked", [
    "-7187856561226066112",
  ]);
  expect(mockBuildPostgresConfig).toHaveBeenCalledWith(
    expect.objectContaining({ DB_APPLICATION_NAME: "nora-test-agent-lock" }),
  );

  await expect(lock.query("SELECT 1")).resolves.toEqual({ rows: [{ locked: true }] });
  await lock.release();
  await lock.release();

  expect(mockClient.query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [
    "-7187856561226066112",
  ]);
  expect(mockClient.end).toHaveBeenCalledTimes(1);
});

it("fails with a bounded conflict when another session keeps the lock", async () => {
  mockClient.query.mockResolvedValue({ rows: [{ locked: false }] });

  await expect(acquireAgentProvisionLock("agent-1", { timeoutMs: 10 })).rejects.toMatchObject({
    code: "AGENT_PROVISION_LOCK_TIMEOUT",
    statusCode: 409,
  });

  expect(mockClient.end).toHaveBeenCalledTimes(1);
});

it("treats a closed session as a safe release when explicit unlock fails", async () => {
  mockClient.query
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockRejectedValueOnce(new Error("connection reset during unlock"));
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  const lock = await acquireAgentProvisionLock("agent-1", { timeoutMs: 10 });
  await expect(lock.release()).resolves.toBeUndefined();

  expect(mockClient.end).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dedicated session was closed/i));
  warn.mockRestore();
});

it("surfaces a failed session close and preserves an unlock failure as context", async () => {
  const unlockError = new Error("connection reset during unlock");
  const closeError = new Error("connection close failed");
  mockClient.query
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockRejectedValueOnce(unlockError);
  mockClient.end.mockRejectedValueOnce(closeError);

  const lock = await acquireAgentProvisionLock("agent-1", { timeoutMs: 10 });
  await expect(lock.release()).rejects.toBe(closeError);

  expect(closeError.unlockError).toBe(unlockError);
});

it("builds one complete replacement contract for operator and admin producers", () => {
  expect(
    buildReplacementDeploymentJob(
      {
        id: "agent-1",
        name: "Agent One",
        user_id: "owner-1",
        status: "stopped",
        container_id: "old-id",
        container_name: "old-name",
        host: "old-host",
        backend_type: "remote-docker",
        runtime_family: "openclaw",
        deploy_target: "remote-docker",
        execution_target_id: "remote:old-host",
        sandbox_profile: "standard",
        vcpu: 4,
        ram_mb: 4096,
        disk_gb: 40,
        image: "old-image",
      },
      {
        runtimeFields: {
          backend_type: "k8s",
          runtime_family: "hermes",
          deploy_target: "k8s",
          execution_target_id: "k8s:new-cluster",
          sandbox_profile: "standard",
        },
        containerName: "new-name",
        image: "new-image",
      },
    ),
  ).toEqual(
    expect.objectContaining({
      id: "agent-1",
      userId: "owner-1",
      backend: "k8s",
      runtime_family: "hermes",
      deploy_target: "k8s",
      execution_target_id: "k8s:new-cluster",
      sandbox_profile: "standard",
      replace_existing_runtime: true,
      previous_container_id: "old-id",
      previous_container_name: "old-name",
      previous_host: "old-host",
      previous_backend: "remote-docker",
      previous_runtime_family: "openclaw",
      previous_deploy_target: "remote-docker",
      previous_execution_target_id: "remote:old-host",
      previous_sandbox_profile: "standard",
    }),
  );
});

it("keeps an existing provision lock across tuple CAS, deployment insert, and queue publication", async () => {
  const agent = {
    id: "agent-1",
    name: "Agent One",
    user_id: "owner-1",
    status: "stopped",
    container_id: "old-id",
    container_name: "old-name",
    host: "old-host",
    backend_type: "docker",
    runtime_family: "openclaw",
    deploy_target: "docker",
    execution_target_id: "docker",
    sandbox_profile: "standard",
  };
  const job = buildReplacementDeploymentJob(agent, {
    runtimeFields: {
      backend_type: "docker",
      runtime_family: "openclaw",
      deploy_target: "docker",
      execution_target_id: "docker",
      sandbox_profile: "standard",
    },
  });
  const queryable = {
    query: jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "agent-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] }),
  };
  const addDeploymentJob = jest.fn().mockResolvedValue({ id: "job-1" });
  const release = jest.fn();
  const provisionLock = { release };

  await expect(
    enqueueReplacementDeployment(agent, job, {
      queryable,
      addDeploymentJob,
      provisionLock,
      skipCancellation: true,
    }),
  ).resolves.toEqual({ id: "job-1" });

  expect(queryable.query).toHaveBeenNthCalledWith(
    1,
    expect.stringMatching(/backend_type = \$5[\s\S]*host IS NOT DISTINCT FROM \$10/),
    [
      "agent-1",
      "stopped",
      "old-id",
      "old-name",
      "docker",
      "openclaw",
      "docker",
      "docker",
      "standard",
      "old-host",
    ],
  );
  expect(addDeploymentJob).toHaveBeenCalledWith(job);
  expect(release).not.toHaveBeenCalled();
});
