import { describe, expect, it } from "vitest";

import * as objectStorage from "../lib/objectStorage.ts";

const { s3Config, StorageError } = objectStorage;

const credentials = { accessKeyId: "key", secretAccessKey: "secret" };

describe("s3Config bucket validation", () => {
  it.each(["logs", "nora-logs.v2", "a1b", "x".repeat(63)])("accepts %s", (bucket) => {
    expect(s3Config({ bucket, ...credentials }).bucket).toBe(bucket);
  });

  it.each([
    "ab",
    "x".repeat(64),
    "Logs",
    "my_bucket",
    "-logs",
    "logs-",
    "evil.example#",
    "evil.example/",
    "a@evil.example",
    "../other",
    "logs?x=1",
    "logs bucket",
  ])("rejects %s", (bucket) => {
    expect(() => s3Config({ bucket, ...credentials })).toThrow(StorageError);
    expect(() => s3Config({ bucket, ...credentials })).toThrow(/bucket name is invalid/);
  });

  it("still reports a missing bucket as not configured", () => {
    expect(() => s3Config({ ...credentials })).toThrow(/not fully configured/);
  });
});
