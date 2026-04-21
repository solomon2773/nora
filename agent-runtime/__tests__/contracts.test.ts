import { describe, expect, it } from "vitest";

import * as contracts from "../lib/contracts.ts";

const {
  AGENT_RUNTIME_PORT,
  HERMES_DASHBOARD_PORT,
  OPENCLAW_GATEWAY_PORT,
  agentRuntimeUrl,
  gatewayUrl,
} = contracts;

describe("runtime contracts", () => {
  it("publishes the stable default ports", () => {
    expect(AGENT_RUNTIME_PORT).toBe(9090);
    expect(OPENCLAW_GATEWAY_PORT).toBe(18789);
    expect(HERMES_DASHBOARD_PORT).toBe(9119);
  });

  it("builds runtime and gateway URLs from the shared contract helpers", () => {
    expect(agentRuntimeUrl("runtime.internal", "health")).toBe(
      "http://runtime.internal:9090/health",
    );
    expect(gatewayUrl("gateway.internal")).toBe("http://gateway.internal:18789/");
    expect(gatewayUrl("gateway.internal", 32000, "chat")).toBe(
      "http://gateway.internal:32000/chat",
    );
  });
});
