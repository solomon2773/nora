// @ts-nocheck
const mockDb = { query: jest.fn() };
jest.mock("../db", () => mockDb);

const { runtimeAuthHeaders } = require("../runtimeAuth");
const { buildRuntimeAuthHeaders } = require("../../agent-runtime/lib/agentEndpoints");

beforeEach(() => mockDb.query.mockReset());

describe("buildRuntimeAuthHeaders", () => {
  it("formats a Bearer header, or nothing when tokenless", () => {
    expect(buildRuntimeAuthHeaders("tok-123")).toEqual({ Authorization: "Bearer tok-123" });
    expect(buildRuntimeAuthHeaders("")).toEqual({});
    expect(buildRuntimeAuthHeaders(null)).toEqual({});
  });
});

describe("runtimeAuthHeaders", () => {
  it("uses the token already on the agent without touching the DB", async () => {
    const headers = await runtimeAuthHeaders({
      id: "a1",
      gateway_token: "from-row",
      deploy_target: "docker",
    });
    expect(headers).toEqual({ Authorization: "Bearer from-row" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it("falls back to a DB lookup when the agent object omits the token", async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ gateway_token: "from-db", deploy_target: "docker" }],
    });
    const headers = await runtimeAuthHeaders({ id: "a1" });
    expect(headers).toEqual({ Authorization: "Bearer from-db" });
    expect(mockDb.query.mock.calls[0][1]).toEqual(["a1"]);
  });

  it("returns no header when neither the row nor the DB has a token", async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    expect(await runtimeAuthHeaders({ id: "a1" })).toEqual({});
  });

  it("fails closed when the canonical agent lookup fails", async () => {
    mockDb.query.mockRejectedValueOnce(new Error("db down"));
    await expect(runtimeAuthHeaders({ id: "a1" })).rejects.toThrow("db down");
  });

  it("does not return runtime credentials after a Remote Docker grant is revoked", async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT \*\s+FROM remote_hosts/.test(sql)) {
        return {
          rows: [
            {
              id: "shared-host",
              owner_user_id: "host-owner",
              label: "Shared host",
              enabled: true,
              ssh_host: "100.64.0.5",
              ssh_port: 22,
              ssh_user: "operator",
              ssh_auth_mode: "key",
              ssh_private_key_encrypted: "secret",
              gateway_host: "100.64.0.5",
              last_test_status: "ok",
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      runtimeAuthHeaders({
        id: "remote-agent",
        user_id: "former-grantee",
        gateway_token: "must-not-be-returned",
        backend_type: "remote-docker",
        deploy_target: "remote-docker",
        execution_target_id: "remote:shared-host",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_HOST_ACCESS_REVOKED", statusCode: 403 });
  });

  it("returns no header for a null/idless agent", async () => {
    expect(await runtimeAuthHeaders(null)).toEqual({});
    expect(await runtimeAuthHeaders({})).toEqual({});
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
