const {
  establishHermesDashboardSession,
  needsHermesLogin,
  HERMES_DASHBOARD_LOGIN_PATH,
} = require("../hermesDashboardSession");

function res(
  status,
  { setCookie = [], location = null }: { setCookie?: string[]; location?: string | null } = {},
) {
  const headers = {
    getSetCookie: () => setCookie,
    get: (name) => (name.toLowerCase() === "location" ? location || null : null),
  };
  return { status, ok: status >= 200 && status < 300, headers };
}

describe("needsHermesLogin", () => {
  it("is true on 401 and 403", () => {
    expect(needsHermesLogin(res(401))).toBe(true);
    expect(needsHermesLogin(res(403))).toBe(true);
  });
  it("is true on a redirect to the login page", () => {
    expect(needsHermesLogin(res(302, { location: "/login?next=%2F" }))).toBe(true);
  });
  it("is false on a redirect that is not the login page", () => {
    expect(needsHermesLogin(res(302, { location: "/dashboard" }))).toBe(false);
  });
  it("is false on 200", () => {
    expect(needsHermesLogin(res(200))).toBe(false);
  });
});

describe("establishHermesDashboardSession", () => {
  it("POSTs derived credentials as JSON and returns the relayed cookie string", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      return res(200, { setCookie: ["hermes_session=abc; Path=/; HttpOnly", "csrf=xyz; Path=/"] });
    };
    const cookie = await establishHermesDashboardSession(
      { host: "10.0.0.5", port: 9119 },
      "seed-123",
      { fetchImpl },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`:9119/${HERMES_DASHBOARD_LOGIN_PATH}`);
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(calls[0].opts.body);
    expect(sent).toMatchObject({ provider: "basic", username: "nora", next: "/" });
    expect(typeof sent.password).toBe("string");
    expect(sent.password.length).toBeGreaterThan(0);
    expect(cookie).toBe("hermes_session=abc; csrf=xyz");
  });

  it("returns null when login fails (non-2xx)", async () => {
    const fetchImpl = async () => res(401);
    const cookie = await establishHermesDashboardSession({ host: "h", port: 9119 }, "seed", {
      fetchImpl,
    });
    expect(cookie).toBeNull();
  });

  it("returns null when the login sets no cookie", async () => {
    const fetchImpl = async () => res(200, { setCookie: [] });
    const cookie = await establishHermesDashboardSession({ host: "h", port: 9119 }, "seed", {
      fetchImpl,
    });
    expect(cookie).toBeNull();
  });
});
