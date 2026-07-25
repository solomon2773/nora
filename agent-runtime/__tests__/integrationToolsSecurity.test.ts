import { describe, expect, it } from "vitest";
import { assertEmailTransportSecurity } from "../lib/integrationTools";

describe("email runtime transport security", () => {
  it("accepts IMAP only when TLS is enabled", () => {
    expect(() => assertEmailTransportSecurity({ imap: { secure: true } })).not.toThrow();
  });

  it.each([false, undefined, null])("rejects an insecure IMAP setting: %s", (secure) => {
    expect(() => assertEmailTransportSecurity({ imap: { secure } })).toThrow(
      /IMAP TLS is required/,
    );
  });
});
