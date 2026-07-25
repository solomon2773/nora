import { describe, expect, it } from "vitest";

import * as dashboardAuth from "../lib/hermesDashboardAuth.ts";

const { HERMES_DASHBOARD_USERNAME, deriveHermesDashboardBasicAuth } = dashboardAuth;

describe("deriveHermesDashboardBasicAuth", () => {
  it("is deterministic for a given seed", () => {
    expect(deriveHermesDashboardBasicAuth("seed-123")).toEqual(
      deriveHermesDashboardBasicAuth("seed-123"),
    );
  });

  it("returns the fixed username and 64-char hex password/secret", () => {
    const creds = deriveHermesDashboardBasicAuth("seed-123");
    expect(creds.username).toBe(HERMES_DASHBOARD_USERNAME);
    expect(creds.password).toMatch(/^[0-9a-f]{64}$/);
    expect(creds.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses distinct labels so password and secret differ", () => {
    const creds = deriveHermesDashboardBasicAuth("seed-123");
    expect(creds.password).not.toBe(creds.secret);
  });

  it("varies by seed", () => {
    expect(deriveHermesDashboardBasicAuth("a").password).not.toBe(
      deriveHermesDashboardBasicAuth("b").password,
    );
  });

  it("rejects an empty seed", () => {
    expect(() => deriveHermesDashboardBasicAuth("")).toThrow();
  });
});
