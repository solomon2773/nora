const DEFAULT_PASSWORD = "SmokePassword123!";

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueEmail(prefix = "nora-e2e-user") {
  return `${prefix}-${uniqueSuffix()}@example.com`;
}

function uniqueName(prefix = "Nora E2E") {
  return `${prefix} ${uniqueSuffix()}`;
}

async function apiJson(
  request,
  path,
  { method = "GET", token = null, data, failOnStatus = true } = {}
) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers["Content-Type"] = "application/json";

  const response = await request.fetch(path, {
    method,
    headers,
    data,
  });
  const raw = await response.text();

  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (failOnStatus && !response.ok()) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${method} ${path} failed with ${response.status()}: ${detail}`);
  }

  return { response, body };
}

async function createUserSession(
  request,
  { email = uniqueEmail("nora-e2e-user"), password = DEFAULT_PASSWORD } = {}
) {
  await apiJson(request, "/api/auth/signup", {
    method: "POST",
    data: { email, password },
  });
  const login = await apiJson(request, "/api/auth/login", {
    method: "POST",
    data: { email, password },
  });

  return {
    email,
    password,
    token: login.body.token,
  };
}

async function getCurrentUser(request, token) {
  const { body } = await apiJson(request, "/api/auth/me", { token });
  return body;
}

async function listAvailableProviders(request, token) {
  const { body } = await apiJson(request, "/api/llm-providers/available", {
    token,
  });
  return Array.isArray(body) ? body : [];
}

async function getPreferredProvider(request, token) {
  const providers = await listAvailableProviders(request, token);
  return providers.find((provider) => provider?.id && provider?.name) || null;
}

async function waitForCondition(
  action,
  { timeoutMs = 15000, intervalMs = 250, description = "condition" } = {}
) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await action();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForOwnedListingByName(request, token, name, options = {}) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/marketplace/mine", { token });
      const listings = Array.isArray(body) ? body : [];
      return listings.find((listing) => listing?.name === name) || null;
    },
    {
      ...options,
      description: `owned listing "${name}"`,
    }
  );
}

async function waitForMarketplaceListingByName(request, token, name, options = {}) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/marketplace", { token });
      const listings = Array.isArray(body) ? body : [];
      return listings.find((listing) => listing?.name === name) || null;
    },
    {
      ...options,
      description: `marketplace listing "${name}"`,
    }
  );
}

async function waitForUserEvent(request, token, matcher, options = {}) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/monitoring/events?limit=100", {
        token,
      });
      const events = Array.isArray(body) ? body : [];
      return events.find((event) => matcher(event)) || null;
    },
    {
      ...options,
      description: "user activity event",
    }
  );
}

async function waitForAdminAuditEvent(request, token, matcher, options = {}) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/admin/audit?limit=100", {
        token,
      });
      const events = Array.isArray(body?.events)
        ? body.events
        : Array.isArray(body)
          ? body
          : [];
      return events.find((event) => matcher(event)) || null;
    },
    {
      ...options,
      description: "admin audit event",
    }
  );
}

async function authenticatePage(page, token, path = "/app/dashboard") {
  await page.addInitScript((storedToken) => {
    window.localStorage.setItem("token", storedToken);
  }, token);
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

function extractIdFromUrl(url, marker) {
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find "${marker}" in URL: ${url}`);
  }

  const rest = url.slice(markerIndex + marker.length);
  return rest.split(/[/?#]/)[0];
}

module.exports = {
  DEFAULT_PASSWORD,
  apiJson,
  authenticatePage,
  createUserSession,
  extractIdFromUrl,
  getCurrentUser,
  getPreferredProvider,
  uniqueEmail,
  uniqueName,
  waitForAdminAuditEvent,
  waitForMarketplaceListingByName,
  waitForOwnedListingByName,
  waitForUserEvent,
};
