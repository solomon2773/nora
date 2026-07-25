// @ts-nocheck
const {
  AUTH_COOKIE_NAME,
  readAuthCookie,
  setAuthCookie,
  clearAuthCookie,
  parseCookieHeader,
  extractSessionTokenFromUpgrade,
} = require("../authCookie");

describe("authCookie", () => {
  describe("AUTH_COOKIE_NAME", () => {
    it("is defined as nora_auth", () => {
      expect(AUTH_COOKIE_NAME).toBe("nora_auth");
    });
  });

  describe("parseCookieHeader", () => {
    it("returns empty object for empty or missing header", () => {
      expect(parseCookieHeader("")).toEqual({});
      expect(parseCookieHeader(null)).toEqual({});
      expect(parseCookieHeader(undefined)).toEqual({});
    });

    it("parses single key-value cookie", () => {
      expect(parseCookieHeader("foo=bar")).toEqual({ foo: "bar" });
    });

    it("trims keys and values", () => {
      expect(parseCookieHeader("  foo  =  bar  ")).toEqual({ foo: "bar" });
    });

    it("parses multiple cookies", () => {
      expect(parseCookieHeader("foo=bar; baz=qux; abc=123")).toEqual({
        foo: "bar",
        baz: "qux",
        abc: "123",
      });
    });

    it("handles cookies with multiple = symbols in value", () => {
      expect(parseCookieHeader("foo=bar=baz")).toEqual({ foo: "bar=baz" });
    });

    it("ignores cookie strings without = symbol", () => {
      expect(parseCookieHeader("invalid-cookie")).toEqual({});
      expect(parseCookieHeader("valid=yes; invalid")).toEqual({ valid: "yes" });
    });

    it("decodes URL encoded values", () => {
      expect(parseCookieHeader("msg=hello%20world")).toEqual({ msg: "hello world" });
    });

    it("falls back to raw value if decoding fails", () => {
      expect(parseCookieHeader("bad=%E0%A4%A")).toEqual({ bad: "%E0%A4%A" });
    });
  });

  describe("readAuthCookie", () => {
    it("returns null if no cookies header is present", () => {
      expect(readAuthCookie({})).toBeNull();
      expect(readAuthCookie({ headers: {} })).toBeNull();
    });

    it("returns value of the auth cookie if present", () => {
      const req = {
        headers: {
          cookie: "other=val; nora_auth=my-jwt-token; another=val",
        },
      };
      expect(readAuthCookie(req)).toBe("my-jwt-token");
    });

    it("returns null if auth cookie is missing but other cookies are present", () => {
      const req = {
        headers: {
          cookie: "other=val; test=cookie",
        },
      };
      expect(readAuthCookie(req)).toBeNull();
    });
  });

  describe("extractSessionTokenFromUpgrade", () => {
    it("prefers the auth cookie over query parameter", () => {
      const req = {
        headers: {
          cookie: "nora_auth=cookie-token",
        },
      };
      const searchParams = {
        get: jest.fn(() => "query-token"),
      };
      const token = extractSessionTokenFromUpgrade(req, searchParams);
      expect(token).toBe("cookie-token");
      expect(searchParams.get).not.toHaveBeenCalled();
    });

    it("falls back to query parameter if cookie is missing", () => {
      const req = {
        headers: {},
      };
      const searchParams = {
        get: jest.fn((key) => (key === "token" ? "query-token" : null)),
      };
      const token = extractSessionTokenFromUpgrade(req, searchParams);
      expect(token).toBe("query-token");
      expect(searchParams.get).toHaveBeenCalledWith("token");
    });

    it("returns null if neither is present", () => {
      const req = {
        headers: {},
      };
      const searchParams = {
        get: jest.fn(() => null),
      };
      const token = extractSessionTokenFromUpgrade(req, searchParams);
      expect(token).toBeNull();
    });

    it("handles missing searchParams safely", () => {
      const req = {
        headers: {},
      };
      const token = extractSessionTokenFromUpgrade(req, null);
      expect(token).toBeNull();
    });
  });

  describe("setAuthCookie", () => {
    let res;
    let originalEnv;

    beforeEach(() => {
      res = {
        cookie: jest.fn(),
      };
      originalEnv = process.env.NORA_FORCE_SECURE_COOKIES;
    });

    afterEach(() => {
      process.env.NORA_FORCE_SECURE_COOKIES = originalEnv;
    });

    it("sets cookie with correct default options (non-secure)", () => {
      const req = { secure: false, headers: {} };
      setAuthCookie(res, "test-token", req);
      expect(res.cookie).toHaveBeenCalledWith("nora_auth", "test-token", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    });

    it("sets secure: true if req.secure is true", () => {
      const req = { secure: true, headers: {} };
      setAuthCookie(res, "test-token", req);
      expect(res.cookie).toHaveBeenCalledWith(
        "nora_auth",
        "test-token",
        expect.objectContaining({ secure: true }),
      );
    });

    it("sets secure: true if x-forwarded-proto header is https", () => {
      const req = {
        secure: false,
        headers: { "x-forwarded-proto": "https" },
      };
      setAuthCookie(res, "test-token", req);
      expect(res.cookie).toHaveBeenCalledWith(
        "nora_auth",
        "test-token",
        expect.objectContaining({ secure: true }),
      );
    });

    it("sets secure: true if NORA_FORCE_SECURE_COOKIES environment variable is 1", () => {
      process.env.NORA_FORCE_SECURE_COOKIES = "1";
      const req = { secure: false, headers: {} };
      setAuthCookie(res, "test-token", req);
      expect(res.cookie).toHaveBeenCalledWith(
        "nora_auth",
        "test-token",
        expect.objectContaining({ secure: true }),
      );
    });
  });

  describe("clearAuthCookie", () => {
    let res;
    let originalEnv;

    beforeEach(() => {
      res = {
        clearCookie: jest.fn(),
      };
      originalEnv = process.env.NORA_FORCE_SECURE_COOKIES;
    });

    afterEach(() => {
      process.env.NORA_FORCE_SECURE_COOKIES = originalEnv;
    });

    it("clears cookie with correct default options (non-secure)", () => {
      const req = { secure: false, headers: {} };
      clearAuthCookie(res, req);
      expect(res.clearCookie).toHaveBeenCalledWith("nora_auth", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
      });
    });

    it("sets secure: true on clearing if req.secure is true", () => {
      const req = { secure: true, headers: {} };
      clearAuthCookie(res, req);
      expect(res.clearCookie).toHaveBeenCalledWith(
        "nora_auth",
        expect.objectContaining({ secure: true }),
      );
    });

    it("sets secure: true on clearing if x-forwarded-proto is https", () => {
      const req = {
        secure: false,
        headers: { "x-forwarded-proto": "https" },
      };
      clearAuthCookie(res, req);
      expect(res.clearCookie).toHaveBeenCalledWith(
        "nora_auth",
        expect.objectContaining({ secure: true }),
      );
    });

    it("sets secure: true on clearing if NORA_FORCE_SECURE_COOKIES is 1", () => {
      process.env.NORA_FORCE_SECURE_COOKIES = "1";
      const req = { secure: false, headers: {} };
      clearAuthCookie(res, req);
      expect(res.clearCookie).toHaveBeenCalledWith(
        "nora_auth",
        expect.objectContaining({ secure: true }),
      );
    });
  });
});
