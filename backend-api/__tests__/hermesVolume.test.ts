const HermesBackend = require("../../workers/provisioner/backends/hermes");

function mockBackend() {
  const removedVolumes = [];
  const backend = new HermesBackend();
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

describe("HermesBackend.destroy volume handling", () => {
  it("removes the home volume on a true delete", async () => {
    const { backend, removedVolumes } = mockBackend();
    await backend.destroy("cid", { agentId: "123", preserveState: false });
    expect(removedVolumes).toContain("nora_hermes_home_123");
  });

  it("keeps the home volume when the caller omits preserveState", async () => {
    const { backend, removedVolumes } = mockBackend();
    await backend.destroy("cid", { agentId: "123" });
    expect(removedVolumes).not.toContain("nora_hermes_home_123");
  });

  it("keeps the home volume on a redeploy (preserveState)", async () => {
    const { backend, removedVolumes } = mockBackend();
    await backend.destroy("cid", { agentId: "123", preserveState: true });
    expect(removedVolumes).not.toContain("nora_hermes_home_123");
  });
});
