function hasHeader(headers, name) {
  const needle = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

type FetchHeaders = Record<string, string>;
type FetchOptions = RequestInit & {
  headers?: FetchHeaders;
  body?: BodyInit | null;
};

function currentMarketingPath(path: string) {
  if (typeof window === "undefined") return path;
  const match = window.location.pathname.match(/^\/app\/(es|fr|zh-Hans|zh-Hant)(?=\/|$)/);
  return match ? `/${match[1]}${path}` : path;
}

// Session auth primarily rides on the HttpOnly `nora_auth` cookie that the
// backend sets at /auth/login. credentials:"include" makes the browser attach
// the cookie on every API call. The Authorization header is still sent when
// a legacy localStorage token exists, so sessions from before the cookie
// migration keep working until they expire or the user logs in again.
// The legacy Authorization bearer token below is attached unconditionally, so
// any URL that escapes this origin takes the token with it. Every current
// caller passes a relative /api/... path, but nothing enforced that.
function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://nora.invalid";
}

/**
 * Resolve a request URL and refuse anything that leaves the current origin.
 *
 * Returns the absolute, origin-pinned URL rather than a bare path. Returning a
 * path is NOT equivalent and is not safe: "https://our-host//evil.com/x" passes
 * the origin check below, but its pathname is "//evil.com/x", and fetch() reads
 * a leading "//" as protocol-relative — so the request, and the Authorization
 * header, would go to evil.com. Handing fetch() the fully resolved URL pins the
 * host that was actually validated.
 *
 * @param url - Caller-supplied absolute or relative request URL.
 * @param origin - Origin to resolve against; defaults to the current page.
 * @returns Absolute URL guaranteed to sit on `origin`.
 */
export function sameOriginUrl(url: string, origin: string = currentOrigin()): string {
  const resolved = new URL(url, origin);
  if (resolved.origin !== origin) {
    throw new Error(`Refusing to send an authenticated request to ${resolved.origin}`);
  }
  return resolved.toString();
}

export async function fetchWithAuth(url: string, options: FetchOptions = {}) {
  const legacyToken = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const headers: FetchHeaders = {
    ...options.headers,
  };
  if (legacyToken && !hasHeader(headers, "authorization")) {
    headers["Authorization"] = `Bearer ${legacyToken}`;
  }

  if (
    options.body != null &&
    typeof options.body === "string" &&
    !hasHeader(headers, "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(sameOriginUrl(url), {
    ...options,
    headers,
    credentials: "include",
  });

  if (res.status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("token");
    window.location.href = currentMarketingPath("/login");
    throw new Error("Unauthorized");
  }

  return res;
}

// Clear both the HttpOnly cookie (server-side) and any legacy localStorage
// token (client-side), then send the user back to login. Callers that want to
// redirect somewhere specific can do so after awaiting this.
export async function logout() {
  if (typeof window === "undefined") return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
  } catch {
    // best-effort; still clear the local token and redirect
  }
  localStorage.removeItem("token");
}
