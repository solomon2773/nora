// Provider strategy interface. Concrete providers (github.ts, slack.ts, ...)
// implement this in PR 4. Until then the LegacyProviderAdapter (PR 3) wraps
// the existing 52-provider switch and the global env-var maps.

import type { IntegrationRow } from "./integration";

export interface DecryptedIntegration {
  row: IntegrationRow;
  token: string | null;
  config: Record<string, unknown>;
}

export interface ConnectivityResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface EnvMapping {
  primary: string | null;
  config: Record<string, string>;
}

export interface RefreshOutcome {
  row: IntegrationRow;
  refreshed: boolean;
}

export type ProviderAuthType =
  | "api_key"
  | "oauth2"
  | "basic"
  | "webhook"
  | "custom"
  | "credentials"
  | "service_account";

export interface ProviderDeps {
  fetch: typeof fetch;
  assertSafeUrl: (url: string, label: string) => Promise<string>;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  ensureEncryptionConfigured: (label: string) => void;
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
}

export interface Provider {
  readonly id: string;
  readonly authType: ProviderAuthType;
  test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult>;
  mapToEnv(ctx: DecryptedIntegration): EnvMapping;
  refreshCredentials?(row: IntegrationRow, deps: ProviderDeps): Promise<RefreshOutcome>;
  sanitizeForSync?(config: Record<string, unknown>): Record<string, unknown>;
}
