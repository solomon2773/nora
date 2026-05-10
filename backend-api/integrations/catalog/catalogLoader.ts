// Loads the static integration catalog from disk and hydrates rows
// returned from the integration_catalog table with schema-derived fields
// (configFields, capabilities, toolSpecs, etc.).
//
// This module owns *all* knowledge of how the JSON catalog spec is shaped
// and which keys are sensitive — services and providers depend on this
// module instead of reading the JSON themselves.

import * as fs from "fs";
import * as path from "path";

import type {
  CatalogConfigField,
  CatalogItem,
  CatalogMcpInfo,
  CatalogSetupGuide,
  CatalogToolSpec,
} from "../types/integration";
import type { IntegrationsRepository } from "../repository/integrationsRepository";

const SECRET_CONFIG_KEY_RE =
  /(token|secret|password|api[_-]?key|private[_-]?key|service[_-]?account|credentials?)/i;

// Providers whose primary credential is a JSON service-account blob and
// whose catalog field key may not match the secret regex.
const GOOGLE_STYLE_SERVICE_ACCOUNT_PROVIDERS = new Set([
  "gcp",
  "google-drive",
  "google-sheets",
  "google-calendar",
  "firebase",
  "google-analytics",
]);

const GOOGLE_STYLE_SERVICE_ACCOUNT_KEYS = ["service_account_json", "credentials_json"];

let catalogCache: CatalogItem[] | null = null;

const CATALOG_PATH = path.join(__dirname, "..", "catalog", "catalog.json");

export function loadCatalog(): CatalogItem[] {
  if (catalogCache) return catalogCache;
  try {
    catalogCache = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  } catch {
    catalogCache = [];
    console.warn("Could not load integration catalog from disk");
  }
  return catalogCache ?? [];
}

export function clearCatalogCache(): void {
  catalogCache = null;
}

export async function seedCatalog(repo: IntegrationsRepository): Promise<void> {
  clearCatalogCache();
  const catalog = loadCatalog();
  for (const item of catalog) {
    try {
      await repo.upsertCatalogItem({
        id: item.id,
        name: item.name,
        icon: item.icon ?? null,
        category: item.category ?? null,
        description: item.description ?? null,
        authType: item.authType ?? null,
        rawJson: JSON.stringify(item),
      });
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("does not exist")) {
        console.error(`Failed to seed catalog item ${item.id}:`, e?.message);
      }
    }
  }
  console.log(`Integration catalog seeded: ${catalog.length} items`);
}

export function resolveCatalogSchema(row: Record<string, any> = {}): Record<string, any> {
  const rawSchema =
    row.config_schema ??
    loadCatalog().find(
      (item) => item.id === row.catalog_id || item.id === row.provider || item.id === row.id,
    );

  if (!rawSchema) return {};

  if (typeof rawSchema === "string") {
    try {
      return JSON.parse(rawSchema);
    } catch {
      return {};
    }
  }

  return rawSchema && typeof rawSchema === "object" ? (rawSchema as Record<string, any>) : {};
}

export interface HydratedCatalogRow extends Record<string, any> {
  configFields: CatalogConfigField[];
  capabilities: string[];
  authType?: string | null;
  toolSpecs: CatalogToolSpec[];
  mcp: CatalogMcpInfo | Record<string, unknown> | null;
  api: Record<string, unknown> | null;
  usageHints: string[];
  credentialsUrl: string | null;
  setupGuide: CatalogSetupGuide | null;
}

export function hydrateRow(row: Record<string, any> = {}): HydratedCatalogRow {
  const schema = resolveCatalogSchema(row);
  return {
    ...row,
    configFields: schema.configFields || [],
    capabilities: schema.capabilities || [],
    authType: schema.authType || row.auth_type,
    toolSpecs: schema.toolSpecs || [],
    mcp: schema.mcp || null,
    api: schema.api || null,
    usageHints: schema.usageHints || [],
    credentialsUrl: schema.credentialsUrl || null,
    setupGuide: schema.setupGuide || null,
  };
}

export async function getCatalog(
  repo: IntegrationsRepository,
  category?: string | null,
): Promise<HydratedCatalogRow[] | CatalogItem[]> {
  try {
    const rows = await repo.getCatalogByCategory(category);
    return rows.map((row) => hydrateRow(row as Record<string, any>));
  } catch {
    const catalog = loadCatalog();
    if (category) return catalog.filter((c) => c.category === category);
    return catalog;
  }
}

export async function getCatalogItem(
  repo: IntegrationsRepository,
  catalogId: string,
): Promise<HydratedCatalogRow | CatalogItem | null> {
  try {
    const row = await repo.getCatalogItemById(catalogId);
    return row ? hydrateRow(row as Record<string, any>) : null;
  } catch {
    return loadCatalog().find((c) => c.id === catalogId) || null;
  }
}

export function getSensitiveConfigKeys(provider: string): Set<string> {
  const catalogItem = loadCatalog().find((item) => item.id === provider);
  const schemaKeys = new Set<string>(
    (catalogItem?.configFields || [])
      .filter((field) => field?.type === "password" || SECRET_CONFIG_KEY_RE.test(field?.key || ""))
      .map((field) => field.key),
  );
  if (GOOGLE_STYLE_SERVICE_ACCOUNT_PROVIDERS.has(provider)) {
    for (const key of GOOGLE_STYLE_SERVICE_ACCOUNT_KEYS) schemaKeys.add(key);
  }
  return schemaKeys;
}

export { SECRET_CONFIG_KEY_RE };
