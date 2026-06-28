// @ts-nocheck
// OpenTelemetry GenAI exporter — unit coverage for the parts that run without
// standing up the SDK. Under jest IS_TEST_ENV is true, so otel never initializes
// and isEnabled() is always false; we assert the disabled no-op contract + the
// pure attribute mapping, plus the per-exchange cost estimate in metrics.ts.

describe("otel GenAI exporter", () => {
  const otel = require("../otel");

  it("is disabled under the test environment (never inits in jest)", () => {
    expect(otel.isEnabled()).toBe(false);
  });

  it("recordChatExchange is a no-op when disabled and never throws", () => {
    expect(() =>
      otel.recordChatExchange({
        agentId: "a1",
        model: "claude-opus-4-8",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.004,
        startedAtMs: Date.now() - 1000,
      }),
    ).not.toThrow();
  });

  it("recordChatExchange tolerates garbage / empty input", () => {
    expect(() => otel.recordChatExchange()).not.toThrow();
    expect(() => otel.recordChatExchange({})).not.toThrow();
    expect(() => otel.recordChatExchange({ inputTokens: "x", costUsd: NaN })).not.toThrow();
  });

  describe("chatAttributes mapping", () => {
    it("maps fields to gen_ai.* / nora.* attribute keys", () => {
      const attrs = otel.chatAttributes({
        model: "gpt-5.5",
        provider: "openai",
        runtimeFamily: "openclaw",
        sandboxProfile: "nemoclaw",
        source: "openclaw.gateway",
        sessionId: "sess-1",
        agentId: "agent-1",
      });
      expect(attrs).toEqual({
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "nora.agent.id": "agent-1",
        "nora.runtime.family": "openclaw",
        "nora.sandbox.profile": "nemoclaw",
        "nora.source": "openclaw.gateway",
        "gen_ai.conversation.id": "sess-1",
      });
    });

    it("always sets the operation name and omits absent fields", () => {
      const attrs = otel.chatAttributes({ model: "claude-opus-4-8" });
      expect(attrs["gen_ai.operation.name"]).toBe("chat");
      expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-8");
      expect(attrs).not.toHaveProperty("gen_ai.system");
      expect(attrs).not.toHaveProperty("nora.agent.id");
      expect(attrs).not.toHaveProperty("gen_ai.conversation.id");
    });

    it("handles empty input without throwing", () => {
      expect(otel.chatAttributes()).toEqual({ "gen_ai.operation.name": "chat" });
    });

    it("omits the unbounded conversation id from METRIC attributes (cardinality guard)", () => {
      const opts = { model: "gpt-5.5", agentId: "a1", sessionId: "attacker-supplied-unbounded-id" };
      // Spans (default) keep it; metrics (includeConversation:false) must not —
      // it is user-supplied session id and would blow up time-series cardinality.
      expect(otel.chatAttributes(opts)["gen_ai.conversation.id"]).toBe(
        "attacker-supplied-unbounded-id",
      );
      const metricAttrs = otel.chatAttributes(opts, { includeConversation: false });
      expect(metricAttrs).not.toHaveProperty("gen_ai.conversation.id");
      expect(metricAttrs["nora.agent.id"]).toBe("a1");
      expect(metricAttrs["gen_ai.request.model"]).toBe("gpt-5.5");
    });
  });
});

describe("metrics.estimateCostUsd (per-exchange, unrounded)", () => {
  const metrics = require("../metrics");
  const ORIGINAL = process.env.COST_MODEL_RATES_JSON;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.COST_MODEL_RATES_JSON;
    else process.env.COST_MODEL_RATES_JSON = ORIGINAL;
  });

  it("returns 0 for empty / zero-token input", () => {
    expect(metrics.estimateCostUsd()).toBe(0);
    expect(metrics.estimateCostUsd({})).toBe(0);
    expect(metrics.estimateCostUsd({ totalTokens: 0 })).toBe(0);
  });

  it("applies the fallback per-1k rate UNROUNDED for sub-cent exchanges", () => {
    // Default fallback is 0.002/1k. 200 tokens -> 0.0004 USD: must NOT round to 0.
    const cost = metrics.estimateCostUsd({ totalTokens: 200 });
    expect(cost).toBeCloseTo(0.0004, 8);
    expect(cost).toBeGreaterThan(0);
  });

  it("never throws on bad input", () => {
    expect(() => metrics.estimateCostUsd({ inputTokens: "nope", model: 42 })).not.toThrow();
    expect(metrics.estimateCostUsd({ inputTokens: "nope" })).toBe(0);
  });
});
