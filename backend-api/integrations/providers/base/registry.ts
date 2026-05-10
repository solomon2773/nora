// Provider registry. Resolves a provider id to its concrete strategy
// implementation, with a fallback factory for any id that doesn't have
// a strategy registered (e.g. a catalog entry added before its provider
// file exists). Registered providers always win over the fallback.

import type { Provider } from "../../types/provider";

export interface ProviderRegistry {
  register(provider: Provider): void;
  has(providerId: string): boolean;
  resolve(providerId: string): Provider;
  list(): Provider[];
}

export type FallbackFactory = (providerId: string) => Provider;

// Re-exported for backward compatibility with callers that imported the
// legacy name during the migration. Prefer FallbackFactory in new code.
export type LegacyFactory = FallbackFactory;

export function createProviderRegistry(fallbackFactory: FallbackFactory): ProviderRegistry {
  const registered = new Map<string, Provider>();

  return {
    register(provider) {
      registered.set(provider.id, provider);
    },
    has(providerId) {
      return registered.has(providerId);
    },
    resolve(providerId) {
      return registered.get(providerId) ?? fallbackFactory(providerId);
    },
    list() {
      return Array.from(registered.values());
    },
  };
}
