import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gatewayRpc from "../lib/gatewayRpc.ts";

const {
  createGatewayClient,
  callLogsTail,
  resolveSafeGatewayTarget,
  computeReconnectDelay,
  GatewayConnectionError,
  GatewayAuthError,
  GatewayScopeError,
  GatewayUnavailableError,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
} = gatewayRpc;

// ─── Fake WebSocket double ───────────────────────────────────────
//
// Implements just enough of the browser-style WebSocket surface that
// gatewayRpc.ts relies on (addEventListener/removeEventListener/send/close/
// readyState) so tests never touch a real socket or DNS.
class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this._listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(cb);
  }

  removeEventListener(type, cb) {
    this._listeners.get(type)?.delete(cb);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }

  close() {
    this._triggerClose();
  }

  _dispatch(type, event = {}) {
    for (const cb of this._listeners.get(type) || []) cb(event);
  }

  // Test-driver helpers below.
  _open() {
    this.readyState = 1;
    this._dispatch("open");
  }

  _receive(frame) {
    this._dispatch("message", { data: JSON.stringify(frame) });
  }

  _triggerError(message = "boom") {
    this._dispatch("error", { message });
  }

  _triggerClose() {
    this.readyState = 3;
    this._dispatch("close");
  }

  // Convenience: open the socket and complete a successful connect handshake.
  _openAndAuthenticate() {
    this._open();
    const connectFrame = JSON.parse(this.sent.at(-1) ?? "null");
    expect(connectFrame?.id).toBe("__connect__");
    this._receive({ type: "res", id: "__connect__", ok: true });
  }
}

function lastSocket() {
  return FakeSocket.instances.at(-1);
}

const agent = { id: "agent-1", gateway_host: "127.0.0.1", gateway_port: 18789 };

// Bypasses DNS/SSRF resolution entirely — that logic is covered separately
// below — so RPC-protocol tests aren't coupled to network resolution timing.
async function fakeResolveTarget() {
  return { url: "ws://127.0.0.1:18789/", host: "127.0.0.1", resolvedHost: "127.0.0.1", port: 18789 };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeReconnectDelay", () => {
  it("doubles from a 1s base and caps at 30s", () => {
    expect(computeReconnectDelay(1)).toBe(1000);
    expect(computeReconnectDelay(2)).toBe(2000);
    expect(computeReconnectDelay(3)).toBe(4000);
    expect(computeReconnectDelay(4)).toBe(8000);
    expect(computeReconnectDelay(5)).toBe(16000);
    expect(computeReconnectDelay(6)).toBe(MAX_RECONNECT_DELAY_MS);
    expect(computeReconnectDelay(7)).toBe(MAX_RECONNECT_DELAY_MS);
    expect(computeReconnectDelay(8)).toBe(MAX_RECONNECT_DELAY_MS);
  });

  it("never exceeds the 30s cap even for attempts far past 8", () => {
    expect(computeReconnectDelay(20)).toBe(MAX_RECONNECT_DELAY_MS);
  });
});

describe("createGatewayClient — request/response correlation", () => {
  it("correlates interleaved concurrent calls by id, resolving each with its own response", async () => {
    const client = createGatewayClient(agent, {
      createSocket: (url) => new FakeSocket(url),
      resolveTarget: fakeResolveTarget,
      token: "secret-token",
    });

    const callA = client.call("logs.tail", { cursor: "a" });
    // Let the connect sequence run (socket creation is async via resolveTarget).
    await vi.waitFor(() => expect(lastSocket()).toBeTruthy());
    lastSocket()._openAndAuthenticate();

    const responseA = callA; // in flight, id will be r1
    const callB = client.call("agent.status", {});
    await vi.waitFor(() => expect(lastSocket().sent.length).toBeGreaterThanOrEqual(3));

    const framesSent = lastSocket().sent.map((s) => JSON.parse(s));
    const reqA = framesSent.find((f) => f.method === "logs.tail");
    const reqB = framesSent.find((f) => f.method === "agent.status");
    expect(reqA.id).not.toBe(reqB.id);

    // Respond out of order: B's id first, then A's id.
    lastSocket()._receive({ type: "res", id: reqB.id, ok: true, payload: { who: "B" } });
    lastSocket()._receive({ type: "res", id: reqA.id, ok: true, payload: { who: "A" } });

    await expect(callB).resolves.toEqual({ who: "B" });
    await expect(responseA).resolves.toEqual({ who: "A" });

    client.close();
  });

  it("does not let an event frame received mid-flight corrupt request/response correlation", async () => {
    const events = [];
    const client = createGatewayClient(agent, {
      createSocket: (url) => new FakeSocket(url),
      resolveTarget: fakeResolveTarget,
      onEvent: (event, payload) => events.push({ event, payload }),
    });

    const callPromise = client.call("logs.tail", { cursor: null });
    await vi.waitFor(() => expect(lastSocket()).toBeTruthy());
    lastSocket()._openAndAuthenticate();
    await vi.waitFor(() => expect(lastSocket().sent.length).toBeGreaterThanOrEqual(2));

    const [reqFrame] = lastSocket().sent.slice(1).map((s) => JSON.parse(s));
    expect(reqFrame.method).toBe("logs.tail");

    // An unrelated event frame arrives while the request is still pending.
    lastSocket()._receive({ type: "event", event: "agent.status.changed", payload: { status: "running" } });
    lastSocket()._receive({ type: "res", id: reqFrame.id, ok: true, payload: { lines: ["x"] } });

    await expect(callPromise).resolves.toEqual({ lines: ["x"] });
    expect(events).toEqual([{ event: "agent.status.changed", payload: { status: "running" } }]);

    client.close();
  });
});

describe("createGatewayClient — error classification", () => {
  it("surfaces an auth failure (bad connect handshake) distinctly from a network failure", async () => {
    const authClient = createGatewayClient(agent, {
      createSocket: (url) => new FakeSocket(url),
      resolveTarget: fakeResolveTarget,
      maxReconnectAttempts: 0,
    });
    const authCall = authClient.call("logs.tail", {});
    await vi.waitFor(() => expect(lastSocket()).toBeTruthy());
    lastSocket()._open();
    lastSocket()._receive({
      type: "res",
      id: "__connect__",
      ok: false,
      error: { code: "invalid_token", message: "token rejected" },
    });
    // An auth failure is terminal immediately — it is never retried, so it
    // never gets wrapped in GatewayUnavailableError the way an exhausted
    // network-retry loop is below.
    await expect(authCall).rejects.toBeInstanceOf(GatewayAuthError);
    authClient.close();

    FakeSocket.instances = [];
    const networkClient = createGatewayClient(agent, {
      createSocket: (url) => new FakeSocket(url),
      resolveTarget: fakeResolveTarget,
      // Zero retries: the single failed attempt exhausts the budget
      // immediately, so the test doesn't need to drive a timer.
      maxReconnectAttempts: 0,
    });
    const networkCall = networkClient.call("logs.tail", {});
    await vi.waitFor(() => expect(lastSocket()).toBeTruthy());
    lastSocket()._triggerError("ECONNREFUSED");

    // A network-shaped failure that exhausts its retry budget surfaces as
    // GatewayUnavailableError (with the underlying network error preserved
    // as `.cause`) — a different shape than an auth rejection, so a caller
    // can tell "your token is bad" apart from "the network/gateway is down".
    await expect(networkCall).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(networkCall).rejects.not.toBeInstanceOf(GatewayAuthError);
    await networkCall.catch((error) => {
      expect(error.cause).toBeInstanceOf(GatewayConnectionError);
    });
    networkClient.close();
  });

  it("surfaces a scope failure distinctly from an auth failure", async () => {
    const client = createGatewayClient(agent, {
      createSocket: (url) => new FakeSocket(url),
      resolveTarget: fakeResolveTarget,
    });
    const callPromise = client.call("logs.tail", {});
    await vi.waitFor(() => expect(lastSocket()).toBeTruthy());
    lastSocket()._openAndAuthenticate();
    await vi.waitFor(() => expect(lastSocket().sent.length).toBeGreaterThanOrEqual(2));

    const [reqFrame] = lastSocket().sent.slice(1).map((s) => JSON.parse(s));
    lastSocket()._receive({
      type: "res",
      id: reqFrame.id,
      ok: false,
      error: { code: "operator_read_scope_required", message: "missing scope: operator.read" },
    });

    await expect(callPromise).rejects.toBeInstanceOf(GatewayScopeError);
    await expect(callPromise).rejects.not.toBeInstanceOf(GatewayAuthError);

    client.close();
  });
});

describe("createGatewayClient — reconnect backoff", () => {
  it("caps reconnection at 8 attempts and surfaces GatewayUnavailableError afterward", async () => {
    vi.useFakeTimers();
    let createCount = 0;
    const client = createGatewayClient(agent, {
      createSocket: (url) => {
        createCount += 1;
        const sock = new FakeSocket(url);
        // Fail asynchronously right after creation, simulating a socket that
        // never reaches "open" (e.g. connection refused).
        queueMicrotask(() => sock._triggerError("refused"));
        return sock;
      },
      resolveTarget: fakeResolveTarget,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    });

    const callPromise = client.call("logs.tail", {});
    // vi.advanceTimersByTimeAsync settles this promise internally, ahead of
    // the `expect(callPromise).rejects` assertion below attaching its own
    // handler — attach one immediately so Node doesn't flag a transient
    // "unhandled rejection" for a rejection this test does handle, just one
    // tick later.
    callPromise.catch(() => {});
    // Let the initial attempt fail, then walk through every scheduled
    // reconnect delay (each capped at 30s) until attempts are exhausted.
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 1; i += 1) {
      await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS);
    }

    await expect(callPromise).rejects.toBeInstanceOf(GatewayUnavailableError);
    // One initial attempt plus at most MAX_RECONNECT_ATTEMPTS retries — never
    // an unbounded retry storm.
    expect(createCount).toBeLessThanOrEqual(MAX_RECONNECT_ATTEMPTS + 1);
    expect(createCount).toBeGreaterThan(1);

    const countAfterExhaustion = createCount;
    await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY_MS * 2);
    expect(createCount).toBe(countAfterExhaustion);

    client.close();
  });
});

describe("resolveSafeGatewayTarget", () => {
  it("resolves a loopback gateway address to a pinned ws:// url", async () => {
    const target = await resolveSafeGatewayTarget(agent);
    expect(target.url).toBe("ws://127.0.0.1:18789/");
  });

  it("rejects a blocked gateway IP (link-local / metadata-style address)", async () => {
    await expect(
      resolveSafeGatewayTarget({ ...agent, gateway_host: "169.254.169.254" }),
    ).rejects.toBeInstanceOf(GatewayConnectionError);
  });

  it("rejects an unspecified address", async () => {
    await expect(
      resolveSafeGatewayTarget({ ...agent, gateway_host: "0.0.0.0" }),
    ).rejects.toBeInstanceOf(GatewayConnectionError);
  });
});

describe("callLogsTail", () => {
  it("is a thin typed wrapper returning { lines, cursor, sourceKind }", async () => {
    const client = { call: vi.fn().mockResolvedValue({ lines: ["a", "b"], cursor: "c2", sourceKind: "stdout" }) };
    const result = await callLogsTail(client, { cursor: "c1", limit: 100, maxBytes: 4096 });
    expect(client.call).toHaveBeenCalledWith("logs.tail", { cursor: "c1", limit: 100, maxBytes: 4096 });
    expect(result).toEqual({ lines: ["a", "b"], cursor: "c2", sourceKind: "stdout" });
  });

  it("defaults missing payload fields rather than throwing", async () => {
    const client = { call: vi.fn().mockResolvedValue({}) };
    const result = await callLogsTail(client, {});
    expect(result).toEqual({ lines: [], cursor: null, sourceKind: null });
  });
});
