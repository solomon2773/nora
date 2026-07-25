// Convenience helpers for building Provider implementations. Concrete
// providers can either implement the Provider interface directly
// (preferred for clarity) or extend BaseProvider for sensible defaults.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderAuthType,
  ProviderDeps,
  RefreshOutcome,
} from "../../types/provider";
import type { IntegrationRow } from "../../types/integration";

/**
 * Shared provider identity contract; concrete strategies must test credentials and map runtime env.
 *
 * Refresh and sync sanitization remain opt-in capabilities for providers that need them.
 */
export abstract class BaseProvider implements Provider {
  readonly id: string;
  readonly authType: ProviderAuthType;

  protected constructor(id: string, authType: ProviderAuthType) {
    this.id = id;
    this.authType = authType;
  }

  abstract test(ctx: DecryptedIntegration, deps: ProviderDeps): Promise<ConnectivityResult>;

  abstract mapToEnv(ctx: DecryptedIntegration): EnvMapping;

  refreshCredentials?(row: IntegrationRow, deps: ProviderDeps): Promise<RefreshOutcome>;

  sanitizeForSync?(config: Record<string, unknown>): Record<string, unknown>;
}

export type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderAuthType,
  ProviderDeps,
  RefreshOutcome,
};
