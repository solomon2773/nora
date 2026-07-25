// @ts-nocheck
const {
  collectOccupiedDockerPublishedPorts,
  createWithDockerPortRetry,
  getOccupiedDockerPublishedPorts,
  isDockerPortBindConflict,
} = require("../../workers/provisioner/backends/dockerPublishedPorts");

describe("Docker published-port inspection", () => {
  it("collects running host ports while ignoring the agent being redeployed", () => {
    const occupied = collectOccupiedDockerPublishedPorts(
      [
        {
          Labels: { "openclaw.agent.id": "other-agent" },
          Ports: [
            { PublicPort: 19000, PrivatePort: 18789, Type: "tcp" },
            { PublicPort: 8080, PrivatePort: 80, Type: "tcp" },
          ],
        },
        {
          Labels: { "openclaw.agent.id": "redeploy-agent" },
          Ports: [{ PublicPort: 19001, PrivatePort: 18789, Type: "tcp" }],
        },
        { Ports: [{ PublicPort: undefined, PrivatePort: 5432, Type: "tcp" }] },
      ],
      { agentId: "redeploy-agent" },
    );

    expect([...occupied]).toEqual([19000, 8080]);
  });

  it("asks Docker only for running containers", async () => {
    const listContainers = jest
      .fn()
      .mockResolvedValue([{ Ports: [{ PublicPort: 19000, PrivatePort: 18789, Type: "tcp" }] }]);

    const occupied = await getOccupiedDockerPublishedPorts({ docker: { listContainers } });

    expect(listContainers).toHaveBeenCalledWith({ all: false });
    expect([...occupied]).toEqual([19000]);
  });

  it("falls back to bind retries when Docker inspection fails", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const occupied = await getOccupiedDockerPublishedPorts({
      docker: { listContainers: jest.fn().mockRejectedValue(new Error("daemon unavailable")) },
    });

    expect([...occupied]).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("relying on bind retry"));
    warning.mockRestore();
  });
});

describe("Docker published-port bind retry", () => {
  it.each([
    "Bind for 127.0.0.1:19000 failed: port is already allocated",
    "failed to bind host port for 0.0.0.0:19000: address already in use",
  ])("recognizes Docker bind conflicts: %s", (message) => {
    expect(isDockerPortBindConflict(new Error(message))).toBe(true);
  });

  it("persists a replacement and retries create with the new port", async () => {
    const attempts = [];
    const create = jest.fn().mockImplementation(async (port) => {
      attempts.push(port);
      if (attempts.length === 1) {
        throw new Error("Bind for 127.0.0.1:19000 failed: port is already allocated");
      }
      return { gatewayHostPort: String(port) };
    });
    const reallocate = jest.fn().mockResolvedValue(19002);

    const result = await createWithDockerPortRetry({
      create,
      initialPort: 19000,
      getOccupiedPorts: async () => new Set([19001]),
      reallocate,
    });

    expect(attempts).toEqual([19000, 19002]);
    expect(reallocate).toHaveBeenCalledWith({
      previousPort: 19000,
      unavailablePorts: [19000, 19001],
    });
    expect(result.gatewayHostPort).toBe("19002");
  });

  it("remembers rejected ports across retries", async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error("port is already allocated"))
      .mockRejectedValueOnce(new Error("address already in use"))
      .mockResolvedValue({ ok: true });
    const reallocate = jest.fn().mockResolvedValueOnce(19001).mockResolvedValueOnce(19002);

    await createWithDockerPortRetry({
      create,
      initialPort: 19000,
      getOccupiedPorts: async () => new Set(),
      reallocate,
    });

    expect(reallocate.mock.calls[1][0].unavailablePorts).toEqual([19000, 19001]);
  });

  it("does not retry non-bind failures", async () => {
    const create = jest.fn().mockRejectedValue(new Error("image pull denied"));
    const reallocate = jest.fn();

    await expect(
      createWithDockerPortRetry({ create, initialPort: 19000, reallocate }),
    ).rejects.toThrow(/image pull denied/);
    expect(reallocate).not.toHaveBeenCalled();
  });

  it("stops after the bounded retry limit", async () => {
    const create = jest.fn().mockRejectedValue(new Error("port is already allocated"));
    const reallocate = jest.fn().mockResolvedValueOnce(19001).mockResolvedValueOnce(19002);

    await expect(
      createWithDockerPortRetry({
        create,
        initialPort: 19000,
        reallocate,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/port is already allocated/);
    expect(create).toHaveBeenCalledTimes(3);
    expect(reallocate).toHaveBeenCalledTimes(2);
  });
});
