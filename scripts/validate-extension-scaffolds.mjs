#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { toCamelCase } from "./scaffold-integration-provider.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_AUTH_TYPES = new Set([
  "api_key",
  "oauth2",
  "basic",
  "webhook",
  "custom",
  "credentials",
  "service_account",
]);
function fail(errors, message) {
  errors.push(message);
}

function collectNavigationPages(entries, pages = new Set()) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === "string") pages.add(entry);
    else if (entry && typeof entry === "object") collectNavigationPages(entry.pages, pages);
  }
  return pages;
}

function collectRegisteredProviders(service) {
  const providers = new Set();
  const registryArray =
    /\[([^\]]*)\]\.forEach\(\s*\(p\)\s*=>\s*providerRegistry\.register\(p\)\s*\);/g;

  for (const match of service.matchAll(registryArray)) {
    const entries = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of entries) {
      if (/^[A-Za-z_$][\w$]*$/.test(entry)) providers.add(entry);
    }
  }

  return providers;
}

export function validateExtensions(root = ROOT) {
  const errors = [];
  const warnings = [];
  const catalogPath = path.join(root, "backend-api", "integrations", "catalog", "catalog.json");
  const servicePath = path.join(
    root,
    "backend-api",
    "integrations",
    "services",
    "integrationsService.ts",
  );
  const interfacePath = path.join(root, "workers", "provisioner", "backends", "interface.ts");
  const docsConfigPath = path.join(root, "docs", "docs.json");
  const integrationDocsDirectory = path.join(root, "docs", "guides", "integrations");

  let catalog = [];
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) {
    fail(errors, `Integration catalog is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(catalog)) fail(errors, "Integration catalog must be an array");

  let navigationPages = new Set();
  try {
    const docsConfig = JSON.parse(fs.readFileSync(docsConfigPath, "utf8"));
    navigationPages = collectNavigationPages(docsConfig?.navigation?.groups);
  } catch (error) {
    fail(errors, `docs/docs.json is not valid JSON: ${error.message}`);
  }

  const service = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, "utf8") : "";
  const registeredProviders = collectRegisteredProviders(service);
  const ids = new Set();
  for (const item of Array.isArray(catalog) ? catalog : []) {
    const id = String(item?.id || "");
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
      fail(errors, `Catalog id is not kebab-case: ${id || "<missing>"}`);
      continue;
    }
    if (ids.has(id)) fail(errors, `Duplicate catalog id: ${id}`);
    ids.add(id);
    if (!item.name || !item.description || !item.category) {
      fail(errors, `${id}: name, description, and category are required`);
    }
    if (!VALID_AUTH_TYPES.has(item.authType))
      fail(errors, `${id}: unsupported authType ${item.authType}`);
    if (!Array.isArray(item.configFields)) fail(errors, `${id}: configFields must be an array`);
    if (!Array.isArray(item.capabilities)) fail(errors, `${id}: capabilities must be an array`);

    const stem = toCamelCase(id);
    const providerFile = path.join(root, "backend-api", "integrations", "providers", `${stem}.ts`);
    const providerIndex = path.join(
      root,
      "backend-api",
      "integrations",
      "providers",
      stem,
      "index.ts",
    );
    if (!fs.existsSync(providerFile) && !fs.existsSync(providerIndex)) {
      fail(errors, `${id}: missing providers/${stem}.ts (or providers/${stem}/index.ts)`);
    }
    const variable = `${stem}Provider`;
    if (!service.includes(`require("../providers/${stem}")`)) {
      fail(errors, `${id}: provider is not imported by integrationsService.ts`);
    }
    if (!registeredProviders.has(variable)) {
      fail(errors, `${id}: ${variable} is not registered`);
    }
    const providerTest = path.join(
      root,
      "backend-api",
      "__tests__",
      "providers",
      `${stem}Provider.test.ts`,
    );
    if (!fs.existsSync(providerTest)) {
      fail(errors, `${id}: missing focused provider test`);
    }
    const docsPage = `guides/integrations/${id}`;
    const docsFile = path.join(integrationDocsDirectory, `${id}.mdx`);
    if (!fs.existsSync(docsFile)) fail(errors, `${id}: missing ${docsPage}.mdx`);
    if (!navigationPages.has(docsPage))
      fail(errors, `${id}: ${docsPage} is missing from docs navigation`);
  }

  if (fs.existsSync(integrationDocsDirectory)) {
    for (const entry of fs.readdirSync(integrationDocsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mdx") || entry.name === "index.mdx") continue;
      const page = `guides/integrations/${entry.name.slice(0, -4)}`;
      if (!navigationPages.has(page)) fail(errors, `${page}: orphan integration guide`);
    }
  }

  if (!service.includes("createProviderRegistry(createStubProvider)")) {
    fail(errors, "Provider registry fallback is missing");
  }

  const backendInterface = fs.existsSync(interfacePath)
    ? fs.readFileSync(interfacePath, "utf8")
    : "";
  for (const method of [
    "create",
    "destroy",
    "status",
    "stats",
    "stop",
    "start",
    "restart",
    "logs",
    "exec",
  ]) {
    if (!new RegExp(`async\\s+${method}\\s*\\(`).test(backendInterface)) {
      fail(errors, `ProvisionerBackend interface is missing ${method}()`);
    }
  }

  return {
    errors,
    warnings,
    catalogProviders: ids.size,
    backendContractMethods: 9,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = validateExtensions();
  for (const warning of result.warnings)
    process.stderr.write(`Extension validation warning: ${warning}\n`);
  if (result.errors.length > 0) {
    process.stderr.write(`Extension validation failed (${result.errors.length}):\n`);
    for (const error of result.errors) process.stderr.write(`  - ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Extension validation passed: ${result.catalogProviders} registered providers; ${result.backendContractMethods} backend contract methods.\n`,
    );
  }
}
