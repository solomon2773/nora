// @ts-nocheck
// LLM provider key management (mounted at /llm-providers). Drift-checked
// against routes/llmProviders.ts.

const ok = (description, schema) => ({
  200: { description, ...(schema ? { content: { "application/json": { schema } } } : {}) },
});

const sessionOnly = {
  "x-session-required": true,
};

const committedReconciliationFailure = {
  502: {
    description:
      "The provider mutation committed, but runtime credential reconciliation or containment could not be confirmed.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["error", "committed", "sync_results"],
          properties: {
            error: { type: "string" },
            committed: { type: "boolean", const: true },
            sync_results: { type: "array", items: { type: "object" } },
          },
          additionalProperties: true,
        },
      },
    },
  },
};

module.exports = {
  "/llm-providers/available": {
    get: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "List supported providers",
      description:
        "Catalog of provider ids, display names, and known models. Entries with requiresApiKey=false (the built-in demo stub) can be added without a key.",
      responses: ok("Provider catalog"),
    },
  },
  "/llm-providers": {
    get: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "List the caller's stored provider keys (masked)",
      responses: ok("Stored providers"),
    },
    post: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "Store a provider API key",
      description:
        "Keys are AES-256-GCM encrypted at rest. The first provider becomes the default. For provider 'demo' the apiKey is omitted — the control plane derives a token for its built-in stub. The request waits for exact running-runtime reconciliation or confirmed stop-and-quarantine containment.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["provider"],
              properties: {
                provider: { type: "string" },
                apiKey: { type: "string", description: "Required except for provider 'demo'." },
                model: { type: "string" },
                config: { type: "object" },
              },
            },
          },
        },
      },
      responses: { ...ok("The stored provider record"), ...committedReconciliationFailure },
    },
  },
  "/llm-providers/{id}": {
    put: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "Update a stored provider (key, model, default flag)",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { ...ok("Updated record"), ...committedReconciliationFailure },
    },
    delete: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "Delete a stored provider key",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { ...ok("Deletion result"), ...committedReconciliationFailure },
    },
  },
  "/llm-providers/sync": {
    post: {
      ...sessionOnly,
      tags: ["LLM Providers"],
      summary: "Push the caller's provider keys to their running agents",
      responses: ok("Sync result"),
    },
  },
};
