// Thin wrapper around the Nora public REST API, mirroring cli/src/client.js.
// Paths are absolute including the `/api` prefix (the public nginx contract).
// Throws ApiError on non-2xx with the server's error message preserved.

import { requireConnection } from "./config.js";

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi({ baseUrl, apiKey, fetchImpl } = {}) {
  const resolved =
    baseUrl && apiKey
      ? { baseUrl, apiKey }
      : { ...requireConnection(), ...(baseUrl ? { baseUrl } : {}) };
  const doFetch = fetchImpl || fetch;

  async function request(method, path, { body, query } = {}) {
    const url = new URL(path, resolved.baseUrl);
    // Defense in depth: every tool path is under `/api/`. URL normalization
    // collapses any `..` segment that slipped through a tool's input schema, so
    // refuse a request whose normalized path escaped the API prefix rather than
    // silently calling an unintended endpoint.
    if (!url.pathname.startsWith("/api/")) {
      throw new ApiError(0, `Refusing request to non-API path: ${url.pathname}`, "invalid_path");
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const response = await doFetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
        "User-Agent": "nora-mcp-server/0.1.4",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && parsed.error) ||
        (typeof parsed === "string" && parsed) ||
        `Request failed (${response.status})`;
      const code =
        parsed && typeof parsed === "object" && typeof parsed.code === "string"
          ? parsed.code
          : null;
      throw new ApiError(response.status, message, code);
    }
    return parsed;
  }

  return {
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) => request("POST", path, { ...(opts || {}), body }),
    delete: (path, opts) => request("DELETE", path, opts),
  };
}
