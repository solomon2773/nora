// @ts-nocheck
const dns = require("node:dns");
const { assertSafeUrl, assertSafeUrlAsync, PRIVATE_IP_RE } = require("../networkSafety");

jest.mock("node:dns", () => ({
  promises: {
    lookup: jest.fn(),
  },
}));

describe("networkSafety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("PRIVATE_IP_RE", () => {
    it("matches local and private IPv4 addresses", () => {
      expect(PRIVATE_IP_RE.test("localhost")).toBe(true);
      expect(PRIVATE_IP_RE.test("127.0.0.1")).toBe(true);
      expect(PRIVATE_IP_RE.test("10.0.0.1")).toBe(true);
      expect(PRIVATE_IP_RE.test("172.16.0.1")).toBe(true);
      expect(PRIVATE_IP_RE.test("172.31.255.255")).toBe(true);
      expect(PRIVATE_IP_RE.test("192.168.1.50")).toBe(true);
      expect(PRIVATE_IP_RE.test("169.254.169.254")).toBe(true);
      expect(PRIVATE_IP_RE.test("100.64.0.1")).toBe(true);
    });

    it("matches local and private IPv6 addresses", () => {
      expect(PRIVATE_IP_RE.test("::1")).toBe(true);
      expect(PRIVATE_IP_RE.test("::")).toBe(true);
      expect(PRIVATE_IP_RE.test("fc00::1")).toBe(true);
      expect(PRIVATE_IP_RE.test("fe80::1")).toBe(true);
    });

    it("does not match public IP addresses or hostnames", () => {
      expect(PRIVATE_IP_RE.test("google.com")).toBe(false);
      expect(PRIVATE_IP_RE.test("8.8.8.8")).toBe(false);
      expect(PRIVATE_IP_RE.test("1.1.1.1")).toBe(false);
      expect(PRIVATE_IP_RE.test("172.15.255.255")).toBe(false); // Out of RFC1918 range
      expect(PRIVATE_IP_RE.test("100.63.255.255")).toBe(false); // Out of CGNAT range
    });
  });

  describe("assertSafeUrl", () => {
    it("returns origin for safe URLs", () => {
      expect(assertSafeUrl("https://google.com/search")).toBe("https://google.com");
      expect(assertSafeUrl("http://example.org:8080/path")).toBe("http://example.org:8080");
    });

    it("throws error for invalid URLs", () => {
      expect(() => assertSafeUrl("not-a-url")).toThrow("URL is not a valid URL");
      expect(() => assertSafeUrl("http//missing-colon.com")).toThrow("URL is not a valid URL");
    });

    it("throws error for unsupported protocols", () => {
      expect(() => assertSafeUrl("ftp://google.com")).toThrow("URL must use http or https");
      expect(() => assertSafeUrl("file:///etc/passwd")).toThrow("URL must use http or https");
      expect(() => assertSafeUrl("gopher://example.com")).toThrow("URL must use http or https");
    });

    it("throws error for hostname literal matching private/local IPs", () => {
      expect(() => assertSafeUrl("http://localhost/")).toThrow(
        "URL must not target internal or private network addresses",
      );
      expect(() => assertSafeUrl("https://127.0.0.1")).toThrow(
        "URL must not target internal or private network addresses",
      );
      expect(() => assertSafeUrl("https://10.0.0.5")).toThrow(
        "URL must not target internal or private network addresses",
      );
      expect(() => assertSafeUrl("https://[::1]")).toThrow(
        "URL must not target internal or private network addresses",
      );
    });

    it("uses custom label in error messages when provided", () => {
      expect(() => assertSafeUrl("ftp://google.com", "TestLabel")).toThrow(
        "TestLabel must use http or https",
      );
      expect(() => assertSafeUrl("http://127.0.0.1", "API endpoint")).toThrow(
        "API endpoint must not target internal or private network addresses",
      );
    });
  });

  describe("assertSafeUrlAsync", () => {
    it("propagates assertion errors from synchronous check", async () => {
      await expect(assertSafeUrlAsync("ftp://google.com")).rejects.toThrow(
        "URL must use http or https",
      );
    });

    it("returns origin immediately for IP literal inputs (no DNS lookup)", async () => {
      const origin = await assertSafeUrlAsync("https://8.8.8.8");
      expect(origin).toBe("https://8.8.8.8");
      expect(dns.promises.lookup).not.toHaveBeenCalled();
    });

    it("returns origin on successful validation after DNS lookup resolves to public IP", async () => {
      dns.promises.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      const origin = await assertSafeUrlAsync("https://example.com/api");
      expect(origin).toBe("https://example.com");
      expect(dns.promises.lookup).toHaveBeenCalledWith("example.com", {
        all: true,
        verbatim: true,
      });
    });

    it("throws when hostname fails to resolve", async () => {
      const dnsError = new Error("getaddrinfo ENOTFOUND non-existent.domain");
      dnsError.code = "ENOTFOUND";
      dns.promises.lookup.mockRejectedValue(dnsError);

      await expect(assertSafeUrlAsync("https://non-existent.domain")).rejects.toThrow(
        "URL hostname non-existent.domain could not be resolved (ENOTFOUND)",
      );
    });

    it("throws when resolved IP address is a private IPv4", async () => {
      dns.promises.lookup.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ]);

      await expect(assertSafeUrlAsync("https://example.com")).rejects.toThrow(
        "URL resolves to a private/internal address (192.168.1.1) and cannot be used",
      );
    });

    it("throws when resolved IP address is a private IPv6", async () => {
      dns.promises.lookup.mockResolvedValue([
        { address: "2001:db8::1", family: 6 },
        { address: "fc00::1", family: 6 },
      ]);

      await expect(assertSafeUrlAsync("https://example.com")).rejects.toThrow(
        "URL resolves to a private/internal address (fc00::1) and cannot be used",
      );
    });
  });
});
