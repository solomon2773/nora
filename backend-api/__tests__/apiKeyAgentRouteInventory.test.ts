// @ts-nocheck

const fs = require("fs");
const path = require("path");

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");
}

describe("workspace API-key agent route inventory", () => {
  it("mounts the workspace guard before the gateway and leaves scopes to each router", () => {
    const server = read("server.ts");
    const workspaceIndex = server.indexOf('app.use("/agents", requireApiKeyAgentPathScope())');
    const gatewayIndex = server.indexOf("app.use(createGatewayRouter())");

    expect(server).not.toContain(
      'app.use("/agents", scopeByMethod("agents:read", "agents:write"))',
    );
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(gatewayIndex).toBeGreaterThan(workspaceIndex);
  });

  it("keeps route-specific agent resources out of the generic agents scope", () => {
    const agents = read("routes/agents.ts");
    for (const segment of [
      "backups",
      "channels",
      "cost",
      "export",
      "files",
      "integrations",
      "mcp-servers",
      "metrics",
    ]) {
      expect(agents).toContain(`"${segment}"`);
    }
    expect(agents).toContain('segments[0] === "activate-demo"');
  });

  it("defers session-only nested agent resources before workspace lookup", () => {
    const ownership = read("middleware/ownership.ts");
    for (const segment of ["backups", "export", "files"]) {
      expect(ownership).toContain(`"${segment}"`);
    }
    expect(ownership).toContain("sessionOnlyNestedSegments.has(segments[1])");
  });

  it.each(["routes/agents.ts", "routes/nemoclaw.ts"])(
    "keeps an explicit :id guard in %s",
    (relativePath) => {
      expect(read(relativePath)).toContain('router.param("id", requireApiKeyAgentScope("id"))');
    },
  );

  it("keeps secret-bearing agent export and filesystem routes session-only", () => {
    const agentFiles = read("routes/agentFiles.ts");
    expect(agentFiles).toContain('router.use("/:id/files", requireSession)');
    expect(agentFiles).toMatch(/"\/:id\/export",\s+requireSession,/);
    expect(agentFiles).not.toContain('router.param("id", requireApiKeyAgentScope("id"))');
  });

  it("keeps gateway and ClawHub agent paths independently guarded", () => {
    expect(read("gatewayProxy.ts")).toMatch(
      /\/agents\/:agentId\/gateway[\s\S]*scopeByMethod\("agents:read", "agents:write"\)[\s\S]*requireApiKeyAgentScope\("agentId"\)/,
    );
    expect(read("routes/clawhub.ts")).toMatch(
      /\/agents\/:agentId\/skills[\s\S]*scopeByMethod\("agents:read", "agents:write"\)[\s\S]*requireApiKeyAgentScope\("agentId"\)/,
    );
  });
});
