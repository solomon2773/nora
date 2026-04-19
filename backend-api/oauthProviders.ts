// @ts-nocheck
const GOOGLE_OIDC_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const SUPPORTED_OAUTH_PROVIDERS = new Set(["google", "github"]);

function normalizeProvider(provider) {
  return typeof provider === "string" ? provider.trim().toLowerCase() : "";
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function parseJsonSafely(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchJson(url, options, providerLabel) {
  const res = await fetch(url, options);
  const data = await parseJsonSafely(res);

  if (!res.ok) {
    const detail = data?.error_description || data?.error || data?.message;
    throw new Error(
      detail
        ? `${providerLabel} token verification failed: ${detail}`
        : `${providerLabel} token verification failed (${res.status})`
    );
  }

  return data || {};
}

function assertRequestedIdentityMatches({ requestedEmail, requestedProviderId, actualEmail, actualProviderId, providerLabel }) {
  if (requestedEmail && normalizeEmail(requestedEmail) !== normalizeEmail(actualEmail)) {
    throw new Error(`${providerLabel} token email did not match the requested account`);
  }

  if (requestedProviderId && String(requestedProviderId) !== String(actualProviderId)) {
    throw new Error(`${providerLabel} account id did not match the requested account`);
  }
}

async function verifyGoogleIdentity({ accessToken, idToken, email, providerId }) {
  let identity;

  if (idToken) {
    const url = `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`;
    const data = await fetchJson(url, undefined, "Google");

    if (!data.sub) throw new Error("Google token verification failed: missing subject");
    if (!data.email) throw new Error("Google token verification failed: missing email");
    if (`${data.email_verified}` !== "true") {
      throw new Error("Google account email is not verified");
    }

    const configuredAudience = process.env.GOOGLE_CLIENT_ID;
    if (configuredAudience && data.aud !== configuredAudience) {
      throw new Error("Google token audience mismatch");
    }

    identity = {
      email: data.email,
      name: data.name || null,
      providerId: data.sub,
    };
  } else if (accessToken) {
    const data = await fetchJson(
      GOOGLE_OIDC_USERINFO_URL,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "Google"
    );

    if (!data.sub) throw new Error("Google token verification failed: missing subject");
    if (!data.email) throw new Error("Google token verification failed: missing email");
    if (data.email_verified !== true) {
      throw new Error("Google account email is not verified");
    }

    identity = {
      email: data.email,
      name: data.name || null,
      providerId: data.sub,
    };
  } else {
    throw new Error("Google OAuth token is required");
  }

  assertRequestedIdentityMatches({
    requestedEmail: email,
    requestedProviderId: providerId,
    actualEmail: identity.email,
    actualProviderId: identity.providerId,
    providerLabel: "Google",
  });

  return identity;
}

async function verifyGitHubIdentity({ accessToken, email, providerId }) {
  if (!accessToken) throw new Error("GitHub OAuth access token is required");

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Nora-Platform",
  };

  const user = await fetchJson(GITHUB_USER_URL, { headers }, "GitHub");
  const emails = await fetchJson(GITHUB_EMAILS_URL, { headers }, "GitHub");
  const primaryVerified = Array.isArray(emails)
    ? emails.find((entry) => entry.primary && entry.verified && entry.email)
      || emails.find((entry) => entry.verified && entry.email)
    : null;
  const verifiedEmail = primaryVerified?.email || null;

  if (!verifiedEmail) {
    throw new Error("GitHub account email is missing or unverified");
  }

  const identity = {
    email: verifiedEmail,
    name: user.name || user.login || null,
    providerId: String(user.id),
  };

  assertRequestedIdentityMatches({
    requestedEmail: email,
    requestedProviderId: providerId,
    actualEmail: identity.email,
    actualProviderId: identity.providerId,
    providerLabel: "GitHub",
  });

  return identity;
}

async function verifyOAuthIdentity({ provider, accessToken, idToken, email, providerId }) {
  const normalizedProvider = normalizeProvider(provider);

  if (!SUPPORTED_OAUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error("Unsupported OAuth provider");
  }

  if (normalizedProvider === "google") {
    return verifyGoogleIdentity({ accessToken, idToken, email, providerId });
  }

  return verifyGitHubIdentity({ accessToken, email, providerId });
}

module.exports = {
  SUPPORTED_OAUTH_PROVIDERS,
  normalizeEmail,
  normalizeProvider,
  verifyOAuthIdentity,
};
