// @ts-nocheck
const queueInstances = new Map();
const mockRedisConstructor = jest.fn().mockImplementation(() => ({}));

jest.mock("ioredis", () => {
  return mockRedisConstructor;
});

jest.mock("bullmq", () => {
  class MockQueue {
    constructor(name) {
      this.name = name;
      this.add = jest.fn();
      this.getJob = jest.fn();
      this.getJobs = jest.fn();
      queueInstances.set(name, this);
    }
  }

  return { Queue: MockQueue };
});

describe("addKubernetesPolicyReconcileJob", () => {
  let addKubernetesPolicyReconcileJob;
  let policySettingsQueue;

  beforeEach(() => {
    jest.resetModules();
    queueInstances.clear();
    mockRedisConstructor.mockClear();
    ({ addKubernetesPolicyReconcileJob, policySettingsQueue } = require("../redisQueue"));
    policySettingsQueue.add.mockReset();
    policySettingsQueue.getJob.mockReset();
  });

  it("does not open a retrying Redis connection during unit-test imports", () => {
    expect(mockRedisConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: expect.any(Function),
      }),
    );
    expect(mockRedisConstructor.mock.calls[0][0].retryStrategy()).toBeNull();
  });

  it("updates a queued job instead of re-enqueueing", async () => {
    const existingJob = {
      getState: jest.fn().mockResolvedValue("waiting"),
      updateData: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    policySettingsQueue.getJob.mockResolvedValue(existingJob);

    const result = await addKubernetesPolicyReconcileJob({
      clusterId: "aks-eastus2",
      desiredHash: "hash-1",
    });

    expect(existingJob.updateData).toHaveBeenCalledWith({
      clusterId: "aks-eastus2",
      desiredHash: "hash-1",
    });
    expect(existingJob.remove).not.toHaveBeenCalled();
    expect(policySettingsQueue.add).not.toHaveBeenCalled();
    expect(result).toBe(existingJob);
  });

  it("enqueues a follow-up job when the existing job is already active", async () => {
    const existingJob = {
      getState: jest.fn().mockResolvedValue("active"),
      updateData: jest.fn(),
      remove: jest.fn(),
    };
    const followUpJob = { id: "k8s-policy-aks-eastus2-followup-test" };
    policySettingsQueue.getJob.mockResolvedValue(existingJob);
    policySettingsQueue.add.mockResolvedValue(followUpJob);

    const result = await addKubernetesPolicyReconcileJob({
      clusterId: "aks-eastus2",
      desiredHash: "hash-2",
    });

    expect(existingJob.updateData).not.toHaveBeenCalled();
    expect(existingJob.remove).not.toHaveBeenCalled();
    expect(policySettingsQueue.add).toHaveBeenCalledWith(
      "reconcile-kubernetes-policy-settings",
      { clusterId: "aks-eastus2", desiredHash: "hash-2" },
      { jobId: expect.stringMatching(/^k8s-policy-aks-eastus2-followup-/) },
    );
    expect(result).toBe(followUpJob);
  });

  it("re-enqueues a fresh job when the previous job already completed", async () => {
    const existingJob = {
      getState: jest.fn().mockResolvedValue("completed"),
      updateData: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const queuedJob = { id: "k8s-policy-aks-eastus2" };
    policySettingsQueue.getJob.mockResolvedValue(existingJob);
    policySettingsQueue.add.mockResolvedValue(queuedJob);

    const result = await addKubernetesPolicyReconcileJob({
      clusterId: "aks-eastus2",
      desiredHash: "hash-2",
    });

    expect(existingJob.remove).toHaveBeenCalled();
    expect(existingJob.updateData).not.toHaveBeenCalled();
    expect(policySettingsQueue.add).toHaveBeenCalledWith(
      "reconcile-kubernetes-policy-settings",
      { clusterId: "aks-eastus2", desiredHash: "hash-2" },
      { jobId: "k8s-policy-aks-eastus2" },
    );
    expect(result).toBe(queuedJob);
  });
});

describe("addDeploymentJob", () => {
  let addDeploymentJob;
  let cancelDeploymentJobsForAgent;
  let deployQueue;

  beforeEach(() => {
    jest.resetModules();
    queueInstances.clear();
    mockRedisConstructor.mockClear();
    ({ addDeploymentJob, cancelDeploymentJobsForAgent, deployQueue } = require("../redisQueue"));
    deployQueue.add.mockReset();
    deployQueue.getJob.mockReset();
    deployQueue.getJobs.mockReset();
  });

  it("deduplicates a durable deployment job id", async () => {
    const existingJob = {
      id: "demo-activation-agent-1",
      getState: jest.fn().mockResolvedValue("delayed"),
      remove: jest.fn(),
    };
    deployQueue.getJob.mockResolvedValue(existingJob);

    await expect(
      addDeploymentJob({ id: "agent-1" }, { jobId: "demo-activation-agent-1" }),
    ).resolves.toBe(existingJob);

    expect(deployQueue.add).not.toHaveBeenCalled();
    expect(existingJob.remove).not.toHaveBeenCalled();
  });

  it("creates the durable job when no prior job exists", async () => {
    deployQueue.getJob.mockResolvedValue(null);
    const queuedJob = { id: "demo-activation-agent-1" };
    deployQueue.add.mockResolvedValue(queuedJob);

    await expect(
      addDeploymentJob({ id: "agent-1" }, { jobId: "demo-activation-agent-1" }),
    ).resolves.toBe(queuedJob);

    expect(deployQueue.add).toHaveBeenCalledWith(
      "deploy-agent",
      { id: "agent-1" },
      { jobId: "demo-activation-agent-1" },
    );
  });

  it.each(["completed", "failed"])(
    "removes and replaces a terminal %s durable deployment job",
    async (state) => {
      const existingJob = {
        id: "demo-activation-agent-1",
        getState: jest.fn().mockResolvedValue(state),
        remove: jest.fn().mockResolvedValue(undefined),
      };
      const replacement = { id: "demo-activation-agent-1" };
      deployQueue.getJob.mockResolvedValue(existingJob);
      deployQueue.add.mockResolvedValue(replacement);

      await expect(
        addDeploymentJob({ id: "agent-1" }, { jobId: "demo-activation-agent-1" }),
      ).resolves.toBe(replacement);

      expect(existingJob.remove).toHaveBeenCalledTimes(1);
      expect(deployQueue.add).toHaveBeenCalledWith(
        "deploy-agent",
        { id: "agent-1" },
        { jobId: "demo-activation-agent-1" },
      );
    },
  );

  it("removes pending jobs for an agent and reports an active job for worker-side cancellation", async () => {
    const waiting = {
      data: { id: "agent-1" },
      getState: jest.fn().mockResolvedValue("waiting"),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const delayed = {
      data: { id: "agent-1" },
      getState: jest.fn().mockResolvedValue("delayed"),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const active = {
      data: { id: "agent-1" },
      getState: jest.fn().mockResolvedValue("active"),
      remove: jest.fn(),
    };
    const otherAgent = {
      data: { id: "agent-2" },
      getState: jest.fn(),
      remove: jest.fn(),
    };
    deployQueue.getJobs.mockResolvedValue([waiting, delayed, active, otherAgent]);

    await expect(cancelDeploymentJobsForAgent("agent-1")).resolves.toEqual({
      removed: 2,
      active: 1,
    });

    expect(deployQueue.getJobs).toHaveBeenCalledWith([
      "active",
      "waiting",
      "waiting-children",
      "delayed",
      "prioritized",
      "failed",
    ]);
    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(delayed.remove).toHaveBeenCalledTimes(1);
    expect(active.remove).not.toHaveBeenCalled();
    expect(otherAgent.getState).not.toHaveBeenCalled();
    expect(otherAgent.remove).not.toHaveBeenCalled();
  });

  it("no-ops when cancellation has no agent id", async () => {
    await expect(cancelDeploymentJobsForAgent()).resolves.toEqual({ removed: 0, active: 0 });
    expect(deployQueue.getJobs).not.toHaveBeenCalled();
  });
});
