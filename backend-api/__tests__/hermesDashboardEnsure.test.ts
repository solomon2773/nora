const { buildHermesDashboardEnsureCommand } = require("../routes/agents");

describe("buildHermesDashboardEnsureCommand", () => {
  it("omits basic-auth exports when no credential is provided", () => {
    const cmd = buildHermesDashboardEnsureCommand();
    expect(cmd).not.toContain("HERMES_DASHBOARD_BASIC_AUTH");
    expect(cmd).toContain('"$HERMES_BIN" dashboard --host 0.0.0.0 --no-open');
  });

  it("exports the derived basic-auth credential before the dashboard launch", () => {
    const cmd = buildHermesDashboardEnsureCommand({
      username: "nora",
      password: "pw-hex",
      secret: "sec-hex",
    });
    expect(cmd).toContain("export HERMES_DASHBOARD_BASIC_AUTH_USERNAME='nora'");
    expect(cmd).toContain("export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='pw-hex'");
    expect(cmd).toContain("export HERMES_DASHBOARD_BASIC_AUTH_SECRET='sec-hex'");
    // exports must precede the launch so the dashboard process inherits them
    expect(cmd.indexOf("BASIC_AUTH_PASSWORD")).toBeLessThan(cmd.indexOf("dashboard --host"));
  });
});
