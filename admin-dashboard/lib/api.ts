type FetchHeaders = Record<string, string>;
type FetchOptions = Omit<RequestInit, "headers"> & {
  headers?: FetchHeaders;
};

function hasHeader(headers: FetchHeaders | undefined, name: string) {
  const needle = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

export async function fetchWithAuth(url: string, options: FetchOptions = {}) {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const headers: FetchHeaders = { ...(options.headers || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (
    options.body != null &&
    typeof options.body === "string" &&
    !hasHeader(headers, "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("token");
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (res.status === 403 && typeof window !== "undefined") {
    window.location.href = "/app/dashboard";
    throw new Error("Forbidden");
  }
  return res;
}
