import { request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

export const DEFAULT_PASSWORD = "SmokePassword123!";
export const DEMO_ADMIN_EMAIL = "nora-demo-activation-admin@example.com";

const E2E_BASE_URL = process.env.BASE_URL || "http://127.0.0.1:18080";
const IGNORE_HTTPS_ERRORS = process.env.ALLOW_LOCAL_HTTPS_ERRORS === "1";

class LoginRequestError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(`POST /api/auth/login failed with ${status}: ${detail}`);
    this.status = status;
  }
}

// /auth/login responses include a Set-Cookie for `nora_auth`; if that cookie
// lands in the shared test `request` jar, every subsequent apiJson(_, _,
// { token }) call will silently authenticate as the cookie's user (the
// backend prefers cookie over Bearer in middleware/auth.ts). Keeping the
// cookie in a throwaway context isolates it.
async function loginInFreshContext(email: string, password: string): Promise<string> {
  const ctx = await playwrightRequest.newContext({
    baseURL: E2E_BASE_URL,
    ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
  });
  try {
    const res = await ctx.post("/api/auth/login", { data: { email, password } });
    if (!res.ok()) {
      const detail = await res.text().catch(() => "");
      throw new LoginRequestError(res.status(), detail);
    }
    const body = (await res.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) {
      throw new Error(`POST /api/auth/login did not return a token`);
    }
    return body.token;
  } finally {
    await ctx.dispose();
  }
}

type ApiJsonOptions = {
  method?: string;
  token?: string | null;
  data?: unknown;
  failOnStatus?: boolean;
  timeout?: number;
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

type CurrentUser = JsonRecord & {
  email?: string;
  role?: string;
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonRecord<T extends JsonRecord>(value: T | string | null, description: string): T {
  if (!isJsonRecord(value)) {
    throw new Error(`Expected JSON object for ${description}`);
  }

  return value as T;
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
  { method = "GET", token = null, data, failOnStatus = true, timeout }: ApiJsonOptions = {},
): Promise<ApiJsonResult<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers["Content-Type"] = "application/json";

  const response = await request.fetch(path, {
    method,
    headers,
    data,
    timeout,
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
  { email = uniqueEmail("nora-e2e-user"), password = DEFAULT_PASSWORD } = {},
): Promise<UserSession> {
  // Signup runs on the shared request context — it doesn't set cookies.
  // Login runs in a throwaway context so its Set-Cookie doesn't poison the
  // shared jar (see loginInFreshContext for the rationale).
  await apiJson(request, "/api/auth/signup", {
    method: "POST",
    data: { email, password },
  });
  const token = await loginInFreshContext(email, password);
  return { email, password, token };
}

async function ensureUserSession(
  request: APIRequestContext,
  { email, password = DEFAULT_PASSWORD }: { email: string; password?: string },
): Promise<UserSession> {
  try {
    const token = await loginInFreshContext(email, password);
    return { email, password, token };
  } catch (error) {
    if (!(error instanceof LoginRequestError) || error.status !== 401) {
      throw error;
    }
  }

  const { response, body } = await apiJson(request, "/api/auth/signup", {
    method: "POST",
    data: { email, password },
    failOnStatus: false,
  });
  if (!response.ok()) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`POST /api/auth/signup failed with ${response.status()}: ${detail}`);
  }
  const token = await loginInFreshContext(email, password);
  return { email, password, token };
}

async function getCurrentUser(request: APIRequestContext, token: string): Promise<CurrentUser> {
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
  // Skip keyless providers (the built-in demo stub): this helper feeds the
  // settings flow that types an API key into the provider form.
  return (
    providers.find(
      (provider) => provider?.id && provider?.name && provider?.requiresApiKey !== false,
    ) || null
  );
}

async function waitForCondition<T>(
  action: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15000, intervalMs = 250, description = "condition" }: WaitForConditionOptions = {},
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
  options: WaitForConditionOptions = {},
) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/agent-hub/mine", { token });
      const listings = Array.isArray(body) ? body : [];
      return listings.find((listing) => listing?.name === name) || null;
    },
    {
      ...options,
      description: `owned listing "${name}"`,
    },
  );
}

async function waitForAgentHubListingByName(
  request: APIRequestContext,
  token: string,
  name: string,
  options: WaitForConditionOptions = {},
) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/agent-hub", { token });
      const listings = Array.isArray(body) ? body : [];
      return listings.find((listing) => listing?.name === name) || null;
    },
    {
      ...options,
      description: `Agent Hub listing "${name}"`,
    },
  );
}

async function waitForUserEvent(
  request: APIRequestContext,
  token: string,
  matcher: (event: Record<string, unknown>) => boolean,
  options: WaitForConditionOptions = {},
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
    },
  );
}

async function waitForAdminAuditEvent(
  request: APIRequestContext,
  token: string,
  matcher: (event: Record<string, unknown>) => boolean,
  options: WaitForConditionOptions = {},
) {
  return waitForCondition(
    async () => {
      const { body } = await apiJson(request, "/api/admin/audit?limit=100", {
        token,
      });
      const events =
        isJsonRecord(body) && Array.isArray(body.events)
          ? body.events
          : Array.isArray(body)
            ? body
            : [];
      return events.find((event) => matcher(event)) || null;
    },
    {
      ...options,
      description: "admin audit event",
    },
  );
}

async function authenticatePage(page: Page, token: string, path = "/app/dashboard") {
  // The backend prefers the HttpOnly session cookie over the Bearer token.
  // When a serial E2E suite switches from one user to another in the same
  // browser context, keeping the previous user's cookie around can silently
  // authenticate subsequent page fetches as the wrong person even if
  // localStorage has the new token. Reset the cookie jar and seed the current
  // session token as the browser cookie before navigation so page-driven API
  // calls and explicit Bearer helpers stay aligned.
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: "nora_auth",
      value: token,
      url: E2E_BASE_URL,
    },
  ]);
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
  ensureUserSession,
  extractIdFromUrl,
  getCurrentUser,
  getPreferredProvider,
  isJsonRecord,
  loginInFreshContext,
  uniqueEmail,
  uniqueName,
  waitForAdminAuditEvent,
  waitForAgentHubListingByName,
  waitForOwnedListingByName,
  waitForUserEvent,
};
