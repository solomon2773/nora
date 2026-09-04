// @ts-nocheck
// Durable agent state (Docker named volumes, the Kubernetes state claim) is
// keyed by agent id, not by container id. A redeploy destroys the previous
// runtime and recreates it against that same state, so every adapter must honor
// `preserveState` — otherwise "replace this runtime" silently means "delete this
// operator's configuration".

const DockerBackend = require("../../workers/provisioner/backends/docker");

function mockDockerBackend() {
  const removedVolumes = [];
  const backend = Object.create(DockerBackend.prototype);
  backend.docker = {
    getContainer: jest.fn().mockReturnValue({
      inspect: jest.fn().mockResolvedValue({ Config: { Labels: {} } }),
      stop: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({}),
    }),
    getVolume: jest.fn().mockImplementation((name) => ({
      remove: jest.fn().mockImplementation(async () => {
        removedVolumes.push(name);
      }),
    })),
  };
  return { backend, removedVolumes };
}

describe("DockerBackend.destroy state preservation", () => {
  it("removes the state and home volumes on a true delete", async () => {
    const { backend, removedVolumes } = mockDockerBackend();

    await backend.destroy("cid", { agentId: "123", preserveState: false });

    expect(removedVolumes).toEqual(
      expect.arrayContaining(["nora_agent_state_123", "nora_agent_home_123"]),
    );
  });

  it("keeps them when the caller omits preserveState", async () => {
    const { backend, removedVolumes } = mockDockerBackend();

    await backend.destroy("cid", { agentId: "123" });

    expect(removedVolumes).toEqual([]);
  });

  it("keeps /root/.openclaw and the state volume across a redeploy", async () => {
    const { backend, removedVolumes } = mockDockerBackend();

    await backend.destroy("cid", { agentId: "123", preserveState: true });

    expect(removedVolumes).toEqual([]);
  });

  it("still removes the container when state is preserved", async () => {
    const { backend } = mockDockerBackend();
    const container = backend.docker.getContainer();

    await backend.destroy("cid", { agentId: "123", preserveState: true });

    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });
});
