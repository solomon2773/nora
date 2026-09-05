export type PlatformMode = "selfhosted" | "paas";
export type BotProtectionProvider = "none" | "turnstile" | "recaptcha";

export type SignupBotProtectionConfig = {
  enabled: boolean;
  provider: BotProtectionProvider | null;
  siteKey: string | null;
  configured: boolean;
  configurationError: string | null;
};

export type AuthBootstrapStatus = {
  needsFirstAdmin: boolean;
  oauthLoginEnabled: boolean;
  platformMode: PlatformMode;
  signupEnabled: boolean;
  signupBotProtection: SignupBotProtectionConfig;
};

function parsePlatformMode(value: unknown): PlatformMode {
  if (value === "selfhosted" || value === "paas") return value;
  throw new Error("Platform mode metadata is invalid");
}

export function parseAuthBootstrapStatus(value: unknown): AuthBootstrapStatus {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid bootstrap status response");
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.needsFirstAdmin !== "boolean") {
    throw new Error("First-admin metadata is invalid");
  }
  if (typeof raw.oauthLoginEnabled !== "boolean") {
    throw new Error("OAuth metadata is invalid");
  }
  // Tolerate a missing field (an older backend during a rolling deploy) by
  // defaulting to enabled — the backend's SIGNUP_DISABLED guard is the
  // security boundary, and rejecting the whole payload here would blank the
  // rest of the bootstrap-driven UI. Reject only a present-but-wrong type.
  if (raw.signupEnabled !== undefined && typeof raw.signupEnabled !== "boolean") {
    throw new Error("Signup availability metadata is invalid");
  }
  const signupEnabled = raw.signupEnabled !== false;

  const protection = raw.signupBotProtection;
  if (!protection || typeof protection !== "object") {
    throw new Error("Signup protection metadata is missing");
  }

  const rawProtection = protection as Record<string, unknown>;
  if (typeof rawProtection.enabled !== "boolean") {
    throw new Error("Signup protection enabled metadata is invalid");
  }
  if (typeof rawProtection.configured !== "boolean") {
    throw new Error("Signup protection configured metadata is invalid");
  }
  const rawProvider = rawProtection.provider;
  if (
    rawProvider !== null &&
    rawProvider !== "none" &&
    rawProvider !== "turnstile" &&
    rawProvider !== "recaptcha"
  ) {
    throw new Error("Signup protection provider metadata is invalid");
  }
  const provider = rawProvider as BotProtectionProvider | null;

  const rawSiteKey = rawProtection.siteKey;
  if (rawSiteKey !== null && typeof rawSiteKey !== "string") {
    throw new Error("Signup protection site-key metadata is invalid");
  }
  const siteKey = typeof rawSiteKey === "string" && rawSiteKey.trim() ? rawSiteKey.trim() : null;

  const rawConfigurationError = rawProtection.configurationError;
  if (rawConfigurationError !== null && typeof rawConfigurationError !== "string") {
    throw new Error("Signup protection error metadata is invalid");
  }
  const configurationError =
    typeof rawConfigurationError === "string" && rawConfigurationError.trim()
      ? rawConfigurationError.trim()
      : null;

  const enabled = rawProtection.enabled;
  const configured = rawProtection.configured;
  if (!enabled && (provider !== "none" || !configured || siteKey || configurationError)) {
    throw new Error("Disabled signup protection metadata is inconsistent");
  }
  if (enabled && provider === "none") {
    throw new Error("Enabled signup protection metadata is inconsistent");
  }
  if (
    enabled &&
    configured &&
    ((provider !== "turnstile" && provider !== "recaptcha") || !siteKey || configurationError)
  ) {
    throw new Error("Configured signup protection metadata is incomplete");
  }
  if (enabled && !configured && !configurationError) {
    throw new Error("Misconfigured signup protection metadata is missing an error");
  }

  return {
    needsFirstAdmin: raw.needsFirstAdmin,
    oauthLoginEnabled: raw.oauthLoginEnabled,
    platformMode: parsePlatformMode(raw.platformMode),
    signupEnabled,
    signupBotProtection: {
      enabled,
      provider,
      siteKey,
      configured,
      configurationError,
    },
  };
}

export async function fetchAuthBootstrapStatus(signal?: AbortSignal): Promise<AuthBootstrapStatus> {
  const response = await fetch("/api/auth/bootstrap-status", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Bootstrap status failed with ${response.status}`);
  }
  return parseAuthBootstrapStatus(await response.json());
}
