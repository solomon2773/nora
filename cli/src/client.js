// Thin wrapper around the Nora public REST API. Uses Node's built-in fetch
// (Node 24+). Throws on non-2xx with the server's error message preserved so
// commands can format it cleanly.

const { load } = require("./config");

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireConfig() {
  const config = load();
  if (!config.host) {
    throw new Error(
      "Nora host is not configured. Run `nora login --host https://...` or set NORA_HOST.",
    );
  }
  if (!config.token) {
    throw new Error("No API token found. Run `nora login --token nora_...` or set NORA_TOKEN.");
  }
  return config;
}

async function request(method, path, { body, query } = {}) {
  const config = requireConfig();
  const url = new URL(path, config.host);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "nora-cli/0.1.0",
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
      parsed && typeof parsed === "object" && typeof parsed.code === "string" ? parsed.code : null;
    throw new ApiError(response.status, message, code);
  }
  return parsed;
}

const api = {
  ApiError,
  get: (path, opts) => request("GET", path, opts),
  post: (path, body, opts) => request("POST", path, { ...(opts || {}), body }),
  patch: (path, body, opts) => request("PATCH", path, { ...(opts || {}), body }),
  delete: (path, opts) => request("DELETE", path, opts),
};

module.exports = api;
