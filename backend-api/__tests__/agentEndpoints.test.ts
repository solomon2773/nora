// @ts-nocheck
/**
 * __tests__/agentEndpoints.test.ts — covers the shared agent-runtime URL helpers
 * as consumed by the backend (the Hermes embed proxy builds its upstream URL via
 * joinHttpUrl). Lives backend-side because agentEndpoints.ts is a CJS module that
 * require()s ./contracts and is exercised by the control plane, not the runtime.
 */
const {
  joinHttpUrl,
  resolveHermesDashboardAddress,
} = require("../../agent-runtime/lib/agentEndpoints");
const { HERMES_DASHBOARD_PORT } = require("../../agent-runtime/lib/contracts");

describe("joinHttpUrl", () => {
  it("builds a plain URL for hostnames and IPv4", () => {
    expect(joinHttpUrl("runtime.internal", 9119, "dashboard")).toBe(
      "http://runtime.internal:9119/dashboard",
    );
    expect(joinHttpUrl("10.0.0.7", 9119)).toBe("http://10.0.0.7:9119/");
  });

  it("brackets IPv6 literals so the address colons don't collide with the port", () => {
    // Without bracketing this would be the unparseable "http://::1:9119/health".
    expect(joinHttpUrl("::1", 9119, "/health")).toBe("http://[::1]:9119/health");
    expect(joinHttpUrl("fd00::1", 8642, "status")).toBe("http://[fd00::1]:8642/status");
    // The bracketed result is a valid, parseable URL (hostname keeps brackets in
    // the WHATWG URL API; the point is that it parses at all, which "::1:9119" does not).
    expect(new URL(joinHttpUrl("::1", 9119, "/health")).href).toBe("http://[::1]:9119/health");
  });
});

describe("resolveHermesDashboardAddress", () => {
  it("returns null for a non-Hermes agent", () => {
    expect(resolveHermesDashboardAddress({ runtime_family: "openclaw" })).toBeNull();
  });

  it("prefers the provisioned gateway exposure address when present (k8s)", () => {
    expect(
      resolveHermesDashboardAddress({
        runtime_family: "hermes",
        gateway_host: "203.0.113.20",
        gateway_port: 30119,
        runtime_host: "10.42.0.3",
      }),
    ).toEqual({ host: "203.0.113.20", port: 30119 });
  });

  it("falls back to runtime_host + default dashboard port for a local container", () => {
    expect(
      resolveHermesDashboardAddress({
        runtime_family: "hermes",
        runtime_host: "10.0.0.7",
      }),
    ).toEqual({ host: "10.0.0.7", port: 9119 });
  });

  it("uses the persisted dashboard_port for a remote agent (published host port)", () => {
    // Remote Hermes advertises runtime_host = the remote machine and persists the
    // published dashboard host port in dashboard_port (B2c-2). No gateway_host is
    // set, so the docker-family branch resolves {runtime_host, dashboard_port}.
    expect(
      resolveHermesDashboardAddress({
        runtime_family: "hermes",
        runtime_host: "laptop.tail-scale.ts.net",
        dashboard_port: 19044,
      }),
    ).toEqual({ host: "laptop.tail-scale.ts.net", port: 19044 });
  });

  it("resolves a local Hermes dashboard on the compose network, not a host port", () => {
    // dashboard_port stays null for local Docker, so the resolver falls back to
    // the compose runtime_host + the container port 9119 (HERMES_DASHBOARD_PORT).
    const agent = {
      runtime_family: "hermes",
      deploy_target: "docker",
      runtime_host: "172.18.0.11",
      runtime_port: 8642,
      dashboard_port: null,
    };
    expect(resolveHermesDashboardAddress(agent)).toEqual({
      host: "172.18.0.11",
      port: HERMES_DASHBOARD_PORT,
    });
  });
});
