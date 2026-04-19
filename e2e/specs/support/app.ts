import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

export const DEFAULT_PASSWORD = "SmokePassword123!";

type ApiJsonOptions = {
  method?: string;
  token?: string | null;
  data?: unknown;
  failOnStatus?: boolean;
};

type ApiJsonResult<T = unknown> = {
  response: APIResponse;
  body: T | string | null;
};

type JsonRecord = Record<string, unknown>;

type ProviderSummary = {
  id?: string;
  name?: string;
  [key: string]: unknown;
};

type WaitForConditionOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  description?: string;
};

type UserSession = {
  email: string;
  password: string;
  token: string;
};

type LoginResponse = JsonRecord & {
  token?: unknown;
};

type CurrentUser = JsonRecord & {
  email?: string;
  role?: string;
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonRecord<T extends JsonRecord>(
  value: T | string | null,
  description: string
): T {
  if (!isJsonRecord(value)) {
    throw new Error(`Expected JSON object for ${description}`);
  }

  return value as T;
}

function readRequiredStringField(
  value: JsonRecord,
  key: string,
  description: string
) {
  const field = value[key];
  if (typeof field !== "string" || !field) {
    throw new Error(`Expected "${key}" string in ${description}`);
  }

  return field;
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueEmail(prefix = "nora-e2e-user") {
  return `${prefix}-${uniqueSuffix()}@example.com`;
}

function uniqueName(prefix = "Nora E2E") {
  return `${prefix} ${uniqueSuffix()}`;
}

async function apiJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  { method = "GET", token = null, data, failOnStatus = true }: ApiJsonOptions = {}
): Promise<ApiJsonResult<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers["Content-Type"] = "application/json";

  const response = await request.fetch(path, {
    method,
    headers,
    data,
  });
  const raw = await response.text();

  let body: T | string | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as T;
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
  request: APIRequestContext,
  { email = uniqueEmail("nora-e2e-user"), password = DEFAULT_PASSWORD } = {}
): Promise<UserSession> {
  await apiJson(request, "/api/auth/signup", {
    method: "POST",
    data: { email, password },
  });
  const login = await apiJson<{ token: string }>(request, "/api/auth/login", {
    method: "POST",
    data: { email, password },
  });
  const loginBody = assertJsonRecord<LoginResponse>(login.body, "/api/auth/login");

  return {
    email,
    password,
    token: readRequiredStringField(loginBody, "token", "/api/auth/login"),
  };
}

async function getCurrentUser(
  request: APIRequestContext,
  token: string
): Promise<CurrentUser> {
  const { body } = await apiJson<CurrentUser>(request, "/api/auth/me", { token });
  return assertJsonRecord(body, "/api/auth/me");
}

async function listAvailableProviders(request: APIRequestContext, token: string) {
  const { body } = await apiJson<ProviderSummary[]>(request, "/api/llm-providers/available", {
    token,
  });
  return Array.isArray(body) ? body : [];
}

async function getPreferredProvider(request: APIRequestContext, token: string) {
  const providers = await listAvailableProviders(request, token);
  return providers.find((provider) => provider?.id && provider?.name) || null;
}

async function waitForCondition<T>(
  action: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15000, intervalMs = 250, description = "condition" }: WaitForConditionOptions = {}
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown = null;

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

async function waitForOwnedListingByName(
  request: APIRequestContext,
  token: string,
  name: string,
  options: WaitForConditionOptions = {}
) {
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

async function waitForMarketplaceListingByName(
  request: APIRequestContext,
  token: string,
  name: string,
  options: WaitForConditionOptions = {}
) {
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

async function waitForUserEvent(
  request: APIRequestContext,
  token: string,
  matcher: (event: Record<string, unknown>) => boolean,
  options: WaitForConditionOptions = {}
) {
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

async function waitForAdminAuditEvent(
  request: APIRequestContext,
  token: string,
  matcher: (event: Record<string, unknown>) => boolean,
  options: WaitForConditionOptions = {}
) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/admin/audit?limit=100", {
        token,
      });
      const events = isJsonRecord(body) && Array.isArray(body.events)
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

async function authenticatePage(page: Page, token: string, path = "/app/dashboard") {
  await page.addInitScript((storedToken) => {
    window.localStorage.setItem("token", storedToken);
  }, token);
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

function extractIdFromUrl(url: string, marker: string) {
  const markerIndex = url.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find "${marker}" in URL: ${url}`);
  }

  const rest = url.slice(markerIndex + marker.length);
  return rest.split(/[/?#]/)[0];
}

export {
  apiJson,
  assertJsonRecord,
  authenticatePage,
  createUserSession,
  extractIdFromUrl,
  getCurrentUser,
  getPreferredProvider,
  isJsonRecord,
  uniqueEmail,
  uniqueName,
  waitForAdminAuditEvent,
  waitForMarketplaceListingByName,
  waitForOwnedListingByName,
  waitForUserEvent,
};
