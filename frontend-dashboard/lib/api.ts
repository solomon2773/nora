function hasHeader(headers, name) {
  const needle = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

type FetchHeaders = Record<string, string>;
type FetchOptions = RequestInit & {
  headers?: FetchHeaders;
  body?: BodyInit | null;
};

export async function fetchWithAuth(url: string, options: FetchOptions = {}) {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const headers: FetchHeaders = {
    ...options.headers,
  };
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

  return res;
}
