import assert from "node:assert/strict";
import test from "node:test";

import {
  highOrCriticalSarifResults,
  listPaginatedJson,
  runCodeqlAlertGate,
} from "./check-codeql-alerts.mjs";

function response(
  payload,
  { ok = true, status = 200, statusText = "OK", headers = new Map() } = {},
) {
  return {
    ok,
    status,
    statusText,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    json: async () => payload,
  };
}

function sarifResult({ alertNumber, ruleId, path, line }) {
  return {
    ruleId,
    properties: { "github/alertNumber": alertNumber },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: path },
          region: { startLine: line },
        },
      },
    ],
  };
}

function sarif(results = []) {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "CodeQL", rules: [] },
          extensions: [
            {
              name: "codeql/javascript-queries",
              rules: [
                { id: "rule/high", properties: { "security-severity": "8.1" } },
                { id: "rule/critical", properties: { "security-severity": "9.4" } },
                { id: "rule/medium", properties: { "security-severity": "6.9" } },
              ],
            },
          ],
        },
        results,
      },
    ],
  };
}

test("highOrCriticalSarifResults keeps exact-analysis high and critical results", () => {
  const results = highOrCriticalSarifResults(
    sarif([
      sarifResult({ alertNumber: 1, ruleId: "rule/high", path: "high.js", line: 10 }),
      sarifResult({ alertNumber: 2, ruleId: "rule/critical", path: "critical.js", line: 20 }),
      sarifResult({ alertNumber: 3, ruleId: "rule/medium", path: "medium.js", line: 30 }),
    ]),
  );

  assert.deepEqual(
    results.map((result) => [result.alertNumber, result.ruleId, result.score]),
    [
      [1, "rule/high", 8.1],
      [2, "rule/critical", 9.4],
    ],
  );
});

test("highOrCriticalSarifResults fails closed on malformed SARIF", () => {
  assert.throws(() => highOrCriticalSarifResults({}), /malformed SARIF/);
});

test("listPaginatedJson follows full pages and stops on the final short page", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ index }));
  const fetchImpl = async (url) => {
    calls.push(new URL(url).searchParams.get("page"));
    return response(calls.length === 1 ? firstPage : [{ index: 100 }]);
  };

  const result = await listPaginatedJson("https://api.github.test/items", {
    token: "token",
    fetchImpl,
  });

  assert.equal(result.length, 101);
  assert.deepEqual(calls, ["1", "2"]);
});

test("listPaginatedJson fails closed when its page cap is exhausted", async () => {
  await assert.rejects(
    listPaginatedJson("https://api.github.test/items", {
      token: "token",
      maxPages: 2,
      fetchImpl: async () => response(Array.from({ length: 100 }, () => ({}))),
    }),
    /pagination exceeded 2 pages/,
  );
});

test("listPaginatedJson retries transient GitHub API failures", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await listPaginatedJson("https://api.github.test/items", {
    token: "token",
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({}, { ok: false, status: 503, statusText: "Unavailable" })
        : response([{ ok: true }]);
    },
  });

  assert.deepEqual(result, [{ ok: true }]);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("listPaginatedJson bounds a hanging GitHub API request", async () => {
  await assert.rejects(
    listPaginatedJson("https://api.github.test/items", {
      token: "token",
      requestTimeoutMs: 5,
      retryAttempts: 1,
      fetchImpl: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    }),
    /request timed out/,
  );
});

test("runCodeqlAlertGate evaluates historical SARIF and ignores only dismissed results", async () => {
  let nowMs = 0;
  let analysisRequests = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/analyses")) {
      analysisRequests += 1;
      assert.equal(parsed.searchParams.get("tool_name"), "CodeQL");
      assert.equal(parsed.searchParams.get("ref"), "refs/heads/master");
      return response(
        analysisRequests === 1
          ? [{ commit_sha: "newer", tool: { name: "CodeQL" }, id: 99 }]
          : [
              { commit_sha: "newer", tool: { name: "CodeQL" }, id: 99 },
              { commit_sha: "target", tool: { name: "CodeQL" }, id: 42 },
            ],
      );
    }
    if (parsed.pathname.endsWith("/analyses/42")) {
      assert.equal(options.headers.Accept, "application/sarif+json");
      return response(
        sarif([
          sarifResult({ alertNumber: 7, ruleId: "rule/high", path: "fixed.js", line: 7 }),
          sarifResult({ alertNumber: 8, ruleId: "rule/critical", path: "dismissed.js", line: 8 }),
        ]),
      );
    }
    if (parsed.pathname.endsWith("/alerts/7")) return response({ number: 7, state: "fixed" });
    if (parsed.pathname.endsWith("/alerts/8")) {
      return response({ number: 8, state: "dismissed" });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await runCodeqlAlertGate({
    repository: "owner/repo",
    targetSha: "target",
    targetRef: "refs/heads/master",
    token: "token",
    timeoutMs: 100,
    pollIntervalMs: 10,
    fetchImpl,
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  });

  assert.equal(analysisRequests, 2);
  assert.equal(result.analysis.id, 42);
  assert.deepEqual(
    result.blockingResults.map((item) => [item.alertNumber, item.state, item.location.path]),
    [[7, "fixed", "fixed.js"]],
  );
});

test("runCodeqlAlertGate keeps a high result that lacks GitHub alert metadata", async () => {
  const payload = sarif([
    sarifResult({ alertNumber: null, ruleId: "rule/high", path: "x.js", line: 1 }),
  ]);
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/analyses")) {
      return response([{ commit_sha: "target", tool: { name: "CodeQL" }, id: 42 }]);
    }
    if (parsed.pathname.endsWith("/analyses/42")) return response(payload);
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await runCodeqlAlertGate({
    repository: "owner/repo",
    targetSha: "target",
    token: "token",
    fetchImpl,
  });

  assert.deepEqual(
    result.blockingResults.map((item) => item.state),
    ["unknown"],
  );
});

test("runCodeqlAlertGate fails closed on API errors", async () => {
  await assert.rejects(
    runCodeqlAlertGate({
      repository: "owner/repo",
      targetSha: "target",
      token: "token",
      retryAttempts: 1,
      fetchImpl: async () => response({}, { ok: false, status: 403, statusText: "Forbidden" }),
    }),
    /403 Forbidden/,
  );
});

test("runCodeqlAlertGate times out when the target analysis never appears", async () => {
  let nowMs = 0;
  await assert.rejects(
    runCodeqlAlertGate({
      repository: "owner/repo",
      targetSha: "target",
      token: "token",
      timeoutMs: 20,
      pollIntervalMs: 10,
      fetchImpl: async () => response([]),
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    }),
    /Timed out waiting for the exact-SHA CodeQL analysis/,
  );
});
