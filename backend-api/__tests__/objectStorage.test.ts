// @ts-nocheck
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const objectStorage = require("../../agent-runtime/lib/objectStorage");

const {
  StorageError,
  normalizeStorageConfig,
  putStorageObject,
  getStorageObject,
  deleteStorageObject,
  listStorageObjects,
  deleteStorageObjects,
  s3Request,
} = objectStorage;

describe("normalizeStorageConfig", () => {
  it("maps legacy backup-flavored field names onto the canonical shape", () => {
    const normalized = normalizeStorageConfig({
      storageBackend: "s3",
      s3Bucket: "my-bucket",
      s3Region: "us-west-2",
      s3Endpoint: "https://example.com",
      s3AccessKeyId: "AKIA",
      s3SecretAccessKey: "secret",
      s3SessionToken: "token",
    });
    expect(normalized).toEqual(
      expect.objectContaining({
        storageBackend: "s3",
        bucket: "my-bucket",
        region: "us-west-2",
        endpoint: "https://example.com",
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        sessionToken: "token",
      }),
    );
  });

  it("is idempotent on an already-canonical config", () => {
    const canonical = normalizeStorageConfig({
      storageBackend: "s3",
      bucket: "bucket",
      region: "us-east-1",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    expect(normalizeStorageConfig(canonical)).toEqual(canonical);
  });

  it("defaults storageBackend to local", () => {
    expect(normalizeStorageConfig({}).storageBackend).toBe("local");
  });
});

describe("local backend round-trip", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nora-object-storage-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function localConfig() {
    return { storageBackend: "local", localPath: tmpDir };
  }

  it("puts, gets, lists, and batch-deletes objects", async () => {
    const config = localConfig();
    await putStorageObject("logs/a.txt", Buffer.from("alpha"), config);
    await putStorageObject("logs/b.txt", Buffer.from("beta"), config);
    await putStorageObject("other/c.txt", Buffer.from("gamma"), config);

    expect((await getStorageObject("logs/a.txt", config)).toString("utf8")).toBe("alpha");

    const listed = await listStorageObjects("logs/", config);
    expect(listed.map((o) => o.key).sort()).toEqual(["logs/a.txt", "logs/b.txt"]);
    for (const object of listed) {
      expect(object.size).toBeGreaterThan(0);
      // jest-environment-node runs each test file in its own vm realm, so a
      // Date minted by Node's internal fs binding (a different realm) fails
      // a same-realm `toBeInstanceOf(Date)` check even though it is a real
      // Date. Assert on shape/behavior instead of identity.
      expect(Object.prototype.toString.call(object.lastModified)).toBe("[object Date]");
      expect(Number.isNaN(object.lastModified.getTime())).toBe(false);
    }

    const result = await deleteStorageObjects(["logs/a.txt", "logs/b.txt"], config);
    expect(result).toEqual({ deleted: 2, errors: [] });
    expect(await listStorageObjects("logs/", config)).toEqual([]);
    // Untouched sibling survives.
    expect((await getStorageObject("other/c.txt", config)).toString("utf8")).toBe("gamma");
  });

  it("deleteStorageObject is a no-op for a missing key (idempotent delete)", async () => {
    const config = localConfig();
    await expect(deleteStorageObject("does/not/exist.txt", config)).resolves.toBeUndefined();
  });

  it("rejects a storage key that escapes the storage root", async () => {
    const config = localConfig();
    await expect(getStorageObject("../../etc/passwd", config)).rejects.toThrow(StorageError);
  });

  it("collects per-key errors in a batch delete without aborting the whole batch", async () => {
    const config = localConfig();
    await putStorageObject("keep/a.txt", Buffer.from("a"), config);
    // Deleting a missing file is treated as success by deleteLocalObject
    // (ENOENT is swallowed), so force a real per-key failure by pointing at
    // a path that can't be unlinked: a non-empty directory used as a "key".
    await fs.mkdir(path.join(tmpDir, "dir-that-is-not-a-file"));
    await fs.writeFile(path.join(tmpDir, "dir-that-is-not-a-file", "inner.txt"), "x");

    const result = await deleteStorageObjects(
      ["keep/a.txt", "dir-that-is-not-a-file"],
      config,
    );
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([expect.objectContaining({ key: "dir-that-is-not-a-file" })]);
  });
});

describe("s3 backend (mocked HTTP, MinIO-shaped path-style config)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function s3TestConfig(overrides = {}) {
    return {
      storageBackend: "s3",
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
      ...overrides,
    };
  }

  it("round-trips put, get, list, and batch delete against a fake MinIO-shaped store", async () => {
    const store = new Map(); // key -> Buffer
    global.fetch = jest.fn(async (url, init) => {
      const parsed = new URL(url);
      const method = init.method;

      if (method === "PUT") {
        const key = decodeURIComponent(parsed.pathname.replace(/^\/test-bucket\//, ""));
        store.set(key, Buffer.from(init.body));
        return new Response(null, { status: 200 });
      }

      if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
        const prefix = parsed.searchParams.get("prefix") || "";
        const matches = [...store.keys()].filter((k) => k.startsWith(prefix));
        const xml = `<?xml version="1.0"?><ListBucketResult>${matches
          .map(
            (key) =>
              `<Contents><Key>${key}</Key><Size>${store.get(key).length}</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>`,
          )
          .join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }

      if (method === "GET") {
        const key = decodeURIComponent(parsed.pathname.replace(/^\/test-bucket\//, ""));
        if (!store.has(key)) return new Response("not found", { status: 404 });
        return new Response(store.get(key), { status: 200 });
      }

      if (method === "POST" && parsed.searchParams.has("delete")) {
        const bodyText = init.body.toString("utf8");
        const keys = [...bodyText.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]);
        for (const key of keys) store.delete(key);
        const xml = `<?xml version="1.0"?><DeleteResult>${keys
          .map((key) => `<Deleted><Key>${key}</Key></Deleted>`)
          .join("")}</DeleteResult>`;
        return new Response(xml, { status: 200 });
      }

      if (method === "DELETE") {
        const key = decodeURIComponent(parsed.pathname.replace(/^\/test-bucket\//, ""));
        store.delete(key);
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const config = s3TestConfig();
    await putStorageObject("logs/a.txt", Buffer.from("alpha"), config);
    await putStorageObject("logs/b.txt", Buffer.from("beta"), config);

    expect((await getStorageObject("logs/a.txt", config)).toString("utf8")).toBe("alpha");

    const listed = await listStorageObjects("logs/", config);
    expect(listed.map((o) => o.key).sort()).toEqual(["logs/a.txt", "logs/b.txt"]);

    const deleteResult = await deleteStorageObjects(["logs/a.txt", "logs/b.txt"], config);
    expect(deleteResult).toEqual({ deleted: 2, errors: [] });
    expect(store.size).toBe(0);
  });

  it("paginates LIST past a single response page by following the continuation token", async () => {
    const calls = [];
    global.fetch = jest.fn(async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.searchParams.get("continuation-token"));
      if (!parsed.searchParams.get("continuation-token")) {
        const xml = `<?xml version="1.0"?><ListBucketResult>
          <Contents><Key>logs/1.txt</Key><Size>1</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>
          <IsTruncated>true</IsTruncated>
          <NextContinuationToken>token-page-2</NextContinuationToken>
        </ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }
      expect(parsed.searchParams.get("continuation-token")).toBe("token-page-2");
      const xml = `<?xml version="1.0"?><ListBucketResult>
        <Contents><Key>logs/2.txt</Key><Size>1</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`;
      return new Response(xml, { status: 200 });
    });

    const listed = await listStorageObjects("logs/", s3TestConfig());
    expect(listed.map((o) => o.key)).toEqual(["logs/1.txt", "logs/2.txt"]);
    expect(calls).toEqual([null, "token-page-2"]);
  });

  it("chunks a 2500-key batch delete into three requests of at most 1000 keys", async () => {
    const requestSizes = [];
    global.fetch = jest.fn(async (url, init) => {
      const bodyText = init.body.toString("utf8");
      const keyCount = [...bodyText.matchAll(/<Key>/g)].length;
      requestSizes.push(keyCount);
      const xml = `<?xml version="1.0"?><DeleteResult></DeleteResult>`;
      return new Response(xml, { status: 200 });
    });

    const keys = Array.from({ length: 2500 }, (_, i) => `logs/${i}.txt`);
    const result = await deleteStorageObjects(keys, s3TestConfig());

    expect(requestSizes).toEqual([1000, 1000, 500]);
    expect(result.deleted).toBe(2500);
    expect(result.errors).toEqual([]);
  });

  it("sends Content-MD5 on batch-delete requests", async () => {
    let capturedHeaders = null;
    global.fetch = jest.fn(async (url, init) => {
      capturedHeaders = init.headers;
      return new Response(`<?xml version="1.0"?><DeleteResult></DeleteResult>`, { status: 200 });
    });

    await deleteStorageObjects(["a.txt"], s3TestConfig());
    expect(capturedHeaders["content-md5"]).toBeTruthy();
  });

  it("propagates a non-2xx response as a StorageError", async () => {
    global.fetch = jest.fn(async () => new Response("access denied", { status: 403 }));
    await expect(getStorageObject("missing.txt", s3TestConfig())).rejects.toThrow(StorageError);
  });

  it("throws STORAGE_S3_NOT_CONFIGURED when required S3 fields are missing", async () => {
    await expect(
      putStorageObject("a.txt", Buffer.from("x"), { storageBackend: "s3" }),
    ).rejects.toMatchObject({ code: "STORAGE_S3_NOT_CONFIGURED" });
  });
});

describe("s3Request SigV4 signing with a query string", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function parseAuthHeader(headerValue) {
    const signedHeadersMatch = headerValue.match(/SignedHeaders=([^,]+)/);
    const signatureMatch = headerValue.match(/Signature=([0-9a-f]+)/);
    return {
      signedHeaders: signedHeadersMatch ? signedHeadersMatch[1] : null,
      signature: signatureMatch ? signatureMatch[1] : null,
    };
  }

  /**
   * Recompute the SigV4 signature exactly as an S3-compatible server would,
   * given the request actually sent, and assert it matches what s3Request
   * put in the Authorization header. This is the regression test for the
   * "canonical request must include the query string" requirement — if the
   * canonical request build ever drops the query string, the two
   * signatures diverge even though this test only observes s3Request's own
   * output (it doesn't hardcode a fixture signature).
   */
  function recomputeSignature({ method, canonicalUri, queryString, headers, payloadHash, config, amzDate, dateStamp }) {
    const sortedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderNames
      .map((name) => `${name}:${String(headers[name]).trim()}\n`)
      .join("");
    const signedHeaders = sortedHeaderNames.join(";");
    const canonicalRequest = [method, canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join(
      "\n",
    );
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const hmacBuf = (key, value) => crypto.createHmac("sha256", key).update(value, "utf8").digest();
    const signingKey = hmacBuf(
      hmacBuf(hmacBuf(hmacBuf(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
      "aws4_request",
    );
    return crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  }

  it("produces a signature that authenticates correctly when the request carries a query string", async () => {
    let capturedUrl = null;
    let capturedHeaders = null;
    global.fetch = jest.fn(async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, {
        status: 200,
      });
    });

    const config = {
      bucket: "test-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      accessKeyId: "minioadmin",
      secretAccessKey: "minioadmin",
    };

    await s3Request("GET", "", null, config, {
      query: { "list-type": "2", prefix: "logs/with spaces+plus" },
    });

    const parsedUrl = new URL(capturedUrl.toString());
    const queryString = parsedUrl.search.replace(/^\?/, "");
    expect(queryString).toContain("prefix=logs%2Fwith%20spaces%2Bplus");

    const { signedHeaders, signature } = parseAuthHeader(capturedHeaders.authorization);
    const headerNames = signedHeaders.split(";");
    const headersForSigning = {};
    for (const name of headerNames) headersForSigning[name] = capturedHeaders[name];

    const amzDate = capturedHeaders["x-amz-date"];
    const dateStamp = amzDate.slice(0, 8);

    const expectedSignature = recomputeSignature({
      method: "GET",
      canonicalUri: "/test-bucket/",
      queryString,
      headers: headersForSigning,
      payloadHash: capturedHeaders["x-amz-content-sha256"],
      config,
      amzDate,
      dateStamp,
    });

    expect(signature).toBe(expectedSignature);
  });
});
