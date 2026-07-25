// @ts-nocheck
const mockRunContainerCommand = jest.fn();

jest.mock("../authSync", () => ({
  runContainerCommand: (...args) => mockRunContainerCommand(...args),
}));

const { createDirectory, listFiles, rootsForAgent, writeFile } = require("../agentFiles");

describe("agentFiles", () => {
  beforeEach(() => {
    mockRunContainerCommand.mockReset();
  });

  it("adds a dedicated writable OpenClaw config root", () => {
    const roots = rootsForAgent({ runtime_family: "openclaw" });

    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openclaw-config",
          label: "OpenClaw Config",
          path: "/root/.openclaw/openclaw.json",
          access: "rw",
          kind: "file",
        }),
      ]),
    );
  });

  it("exposes the OpenClaw runtime home as a read-only root", () => {
    const roots = rootsForAgent({ runtime_family: "openclaw" });

    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agent-runtime",
          label: "Agent Runtime",
          path: "/root/.openclaw",
          access: "ro",
          kind: "directory",
        }),
      ]),
    );
  });

  it("lists the dedicated OpenClaw config root as a single editable file", async () => {
    mockRunContainerCommand.mockResolvedValueOnce({
      output: "openclaw.json\u0000f\u000042\u00001714584723\u0000",
    });

    const result = await listFiles({ runtime_family: "openclaw" }, "openclaw-config");

    expect(result.root).toEqual(
      expect.objectContaining({
        id: "openclaw-config",
        access: "rw",
        kind: "file",
      }),
    );
    expect(result.entries).toEqual([
      expect.objectContaining({
        name: "openclaw.json",
        path: "openclaw.json",
        type: "file",
        writable: true,
      }),
    ]);
    expect(mockRunContainerCommand).toHaveBeenCalledTimes(1);
  });

  it("allows editing openclaw.json through the dedicated config root", async () => {
    mockRunContainerCommand.mockResolvedValueOnce({ output: "" });

    await expect(
      writeFile(
        { runtime_family: "openclaw" },
        "openclaw-config",
        "openclaw.json",
        Buffer.from('{"runtime":"ok"}').toString("base64"),
      ),
    ).resolves.toEqual({ success: true });

    expect(mockRunContainerCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects writes outside openclaw.json for the dedicated config root", async () => {
    await expect(
      writeFile(
        { runtime_family: "openclaw" },
        "openclaw-config",
        "workspace/notes.txt",
        Buffer.from("nope").toString("base64"),
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Only openclaw.json can be edited from this filesystem root",
    });

    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });

  it("rejects directory mutations for the dedicated config root", async () => {
    await expect(
      createDirectory({ runtime_family: "openclaw" }, "openclaw-config", "backup"),
    ).rejects.toMatchObject({
      statusCode: 403,
      message:
        "This filesystem root only supports editing and downloading the OpenClaw config file",
    });

    expect(mockRunContainerCommand).not.toHaveBeenCalled();
  });
});
