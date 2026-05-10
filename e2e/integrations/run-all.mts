#!/usr/bin/env tsx
// Real-credential integration smoke harness.
//
// Reads e2e/integrations/.env.providers, iterates the integration catalog,
// and invokes each migrated provider's test() against the live API using
// the user's own credentials. Skips providers that have no strategy file
// or whose required env vars are blank.
//
// Run: cd e2e && npm run smoke:integrations
//
// This is intentionally NOT a Jest/Playwright test — it talks to real
// third-party services and is not safe for CI.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE = path.join(__dirname, ".env.providers");
const CATALOG_FILE = path.join(REPO_ROOT, "backend-api", "integrations", "catalog", "catalog.json");
const PROVIDERS_DIR = path.join(REPO_ROOT, "backend-api", "integrations", "providers");

type EnvMap = Record<string, string>;
type CatalogEntry = {
  id: string;
  name: string;
  authType?: string;
  configFields?: Array<{ key: string; required?: boolean; type?: string }>;
};

function loadEnvProviders(): EnvMap {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`No .env.providers file at ${ENV_FILE}`);
    console.error(`Copy .env.providers.example to .env.providers and fill in credentials.`);
    process.exit(2);
  }
  const out: EnvMap = {};
  const text = fs.readFileSync(ENV_FILE, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function loadCatalog(): CatalogEntry[] {
  return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
}

// Resolves the provider strategy file path. Returns null when the provider
// hasn't been migrated yet (still living in legacy/).
function findProviderFile(id: string): string | null {
  const p = path.join(PROVIDERS_DIR, `${id}.ts`);
  return fs.existsSync(p) ? p : null;
}

// Per-provider env-var groups: which catalog id needs which env vars
// populated to be considered "credentialed". We can't derive this from
// the catalog alone because credential field keys (e.g. "client_id")
// don't always match the env var name (e.g. "TWITTER_CLIENT_ID").
// Each provider's strategy file is the source of truth via mapToEnv —
// we read provider.mapToEnv()'s required env keys at run time.

type DecryptedIntegrationCtx = {
  row: {
    id: string;
    agent_id: string;
    provider: string;
    catalog_id: string;
    access_token: string | null;
    config: Record<string, unknown>;
    status: string;
  };
  token: string | null;
  config: Record<string, unknown>;
};

type ConnectivityResult = { success: boolean; message?: string; error?: string };

type Provider = {
  id: string;
  authType: string;
  test(ctx: DecryptedIntegrationCtx, deps: any): Promise<ConnectivityResult>;
  mapToEnv(ctx: DecryptedIntegrationCtx): {
    primary: string | null;
    config: Record<string, string>;
  };
};

function loadProvider(id: string): Provider | null {
  const filepath = findProviderFile(id);
  if (!filepath) return null;
  // CommonJS interop — provider modules use `require` style exports
  // because the rest of backend-api does. Use createRequire so we don't
  // have to compile TS first.
  const { createRequire } = require("node:module");
  const requireFromHere = createRequire(import.meta.url);
  // Use ts-node compilation if available, otherwise fall back to tsx loader.
  // tsx is what runs this script, so .ts files imported through require
  // are compiled on the fly.
  try {
    const mod = requireFromHere(filepath);
    const exportName = `${id.replace(/-/g, "")}Provider`;
    // Try kebab-case exports first, then exact-case
    return (
      mod[exportName] ||
      mod[`${id}Provider`] ||
      mod[`${capitalize(id)}Provider`] ||
      mod.default ||
      null
    );
  } catch (e: any) {
    console.warn(`Could not load provider ${id}: ${e.message}`);
    return null;
  }
}

function capitalize(s: string): string {
  return s.replace(/(^|-)([a-z])/g, (_, _sep, c) => c.toUpperCase()).replace(/-/g, "");
}

// Builds a synthetic DecryptedIntegration ctx from the env vars the user
// populated. Each provider declares which env vars it expects via mapToEnv;
// we feed the raw env values back in as config + token so the test() call
// behaves identically to the dashboard path.
function buildCtxFromEnv(
  provider: Provider,
  env: EnvMap,
  catalog: CatalogEntry,
): DecryptedIntegrationCtx | null {
  // Run mapToEnv with empty config to discover which env keys this provider
  // expects. We mirror those env values back into the ctx config under their
  // catalog field keys.
  const probe = provider.mapToEnv({
    row: {
      id: "probe",
      agent_id: "probe",
      provider: provider.id,
      catalog_id: provider.id,
      access_token: "",
      config: {},
      status: "active",
    },
    token: "",
    config: {},
  });
  const requiredEnvKeys = [probe.primary, ...Object.values(probe.config)].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );

  const populated = requiredEnvKeys.every((envKey) => env[envKey] && env[envKey].trim() !== "");
  if (!populated) return null;

  // Reconstruct the catalog config keys → env values mapping by inverting
  // mapToEnv. For each (catalogConfigKey -> envKey) pair we copy env[envKey]
  // into config[catalogConfigKey].
  const config: Record<string, unknown> = {};
  for (const [configKey, envKey] of Object.entries(probe.config)) {
    if (typeof envKey === "string" && env[envKey]) config[configKey] = env[envKey];
  }
  const token = probe.primary && env[probe.primary] ? env[probe.primary] : null;

  return {
    row: {
      id: `smoke-${provider.id}`,
      agent_id: "smoke",
      provider: provider.id,
      catalog_id: catalog.id,
      access_token: token,
      config,
      status: "active",
    },
    token,
    config,
  };
}

const providerDeps = {
  fetch: (...args: any[]) => (globalThis as any).fetch(...args),
  assertSafeUrl: async (url: string) => url,
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
  ensureEncryptionConfigured: () => {},
  db: { query: async () => ({ rows: [] }) },
};

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
};

async function main() {
  const env = loadEnvProviders();
  const catalog = loadCatalog();
  console.log(`Integration smoke run`);
  console.log(`=====================`);
  console.log(`Catalog: ${catalog.length} entries; env file: ${ENV_FILE}\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ id: string; message: string }> = [];

  for (let i = 0; i < catalog.length; i++) {
    const entry = catalog[i];
    const idx = `[${String(i + 1).padStart(String(catalog.length).length, " ")}/${catalog.length}]`;
    const provider = loadProvider(entry.id);

    if (!provider) {
      console.log(`${idx} ${entry.id.padEnd(22)} ${C.dim}⊘ not migrated yet${C.reset}`);
      skipped++;
      continue;
    }

    const ctx = buildCtxFromEnv(provider, env, entry);
    if (!ctx) {
      console.log(`${idx} ${entry.id.padEnd(22)} ${C.dim}⊘ skipped (no credentials)${C.reset}`);
      skipped++;
      continue;
    }

    try {
      const result = await provider.test(ctx, providerDeps);
      if (result.success) {
        console.log(
          `${idx} ${entry.id.padEnd(22)} ${C.green}✓${C.reset} ${result.message || "ok"}`,
        );
        passed++;
      } else {
        const msg = result.error || result.message || "unknown failure";
        console.log(`${idx} ${entry.id.padEnd(22)} ${C.red}✗${C.reset} ${msg}`);
        failed++;
        failures.push({ id: entry.id, message: msg });
      }
    } catch (e: any) {
      console.log(`${idx} ${entry.id.padEnd(22)} ${C.red}✗${C.reset} ${e.message}`);
      failed++;
      failures.push({ id: entry.id, message: e.message });
    }
  }

  console.log(
    `\nSummary: ${C.green}${passed} ✓${C.reset}  ${C.red}${failed} ✗${C.reset}  ${C.dim}${skipped} ⊘${C.reset}`,
  );
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  - ${f.id}: ${f.message}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke runner crashed:", e);
  process.exit(2);
});
