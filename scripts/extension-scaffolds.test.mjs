import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

import {
  normalizeChangedPaths,
  normalizeScopes,
  packagesForSetup,
  parseCli,
  scopesForFiles,
} from "./contributor.mjs";
import { scaffoldBackendAdapter } from "./scaffold-backend-adapter.mjs";
import { scaffoldIntegration } from "./scaffold-integration-provider.mjs";
import { validateExtensions } from "./validate-extension-scaffolds.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nora-scaffold-"));
  for (const directory of [
    "backend-api/integrations/catalog",
    "backend-api/integrations/services",
    "backend-api/integrations/providers",
    "backend-api/__tests__/providers",
    "workers/provisioner/backends",
    "docs/guides/integrations",
    "e2e/integrations",
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "backend-api/integrations/catalog/catalog.json"), "[]\n");
  fs.writeFileSync(
    path.join(root, "backend-api/integrations/services/integrationsService.ts"),
    `const providerRegistry = createProviderRegistry(createStubProvider);
const repo = createIntegrationsRepository(db);
[
].forEach((p) => providerRegistry.register(p));
`,
  );
  fs.writeFileSync(path.join(root, "e2e/integrations/.env.providers.example"), "# Providers\n");
  fs.writeFileSync(
    path.join(root, "docs/docs.json"),
    `${JSON.stringify(
      {
        navigation: {
          groups: [
            {
              group: "Guides",
              pages: [
                {
                  group: "Per-provider integrations",
                  pages: ["guides/integrations/index"],
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "workers/provisioner/backends/interface.js"),
    "class ProvisionerBackend {}\nmodule.exports = ProvisionerBackend;\n",
  );
  fs.writeFileSync(
    path.join(root, "workers/provisioner/backends/interface.ts"),
    `class ProvisionerBackend {
  async create() {}
  async destroy() {}
  async status() {}
  async stats() {}
  async stop() {}
  async start() {}
  async restart() {}
  async logs() {}
  async exec() {}
}
`,
  );
  return root;
}

test("integration scaffolder creates deterministic provider wiring", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await scaffoldIntegration({
    root,
    id: "acme-cloud",
    name: "Acme Cloud",
    primaryEnv: "ACME_API_KEY",
    testUrl: "https://api.acme.example/v1/me",
    credentialsUrl: "https://acme.example/settings/tokens",
  });

  assert.equal(result.files.length, 7);
  const provider = fs.readFileSync(
    path.join(root, "backend-api/integrations/providers/acmeCloud.ts"),
    "utf8",
  );
  assert.match(provider, /export const acmeCloudProvider/);
  assert.match(provider, /ACME_API_KEY/);

  const catalog = JSON.parse(
    fs.readFileSync(path.join(root, "backend-api/integrations/catalog/catalog.json"), "utf8"),
  );
  assert.deepEqual(
    catalog.map((item) => item.id),
    ["acme-cloud"],
  );

  const service = fs.readFileSync(
    path.join(root, "backend-api/integrations/services/integrationsService.ts"),
    "utf8",
  );
  assert.match(service, /require\("\.\.\/providers\/acmeCloud"\)/);
  assert.match(service, /\[acmeCloudProvider\]\.forEach/);
  assert.match(
    fs.readFileSync(path.join(root, "e2e/integrations/.env.providers.example"), "utf8"),
    /^ACME_API_KEY=$/m,
  );
  const docsConfig = JSON.parse(fs.readFileSync(path.join(root, "docs/docs.json"), "utf8"));
  assert.deepEqual(docsConfig.navigation.groups[0].pages[0].pages, [
    "guides/integrations/index",
    "guides/integrations/acme-cloud",
  ]);
  for (const file of [
    "backend-api/integrations/providers/acmeCloud.ts",
    "backend-api/__tests__/providers/acmeCloudProvider.test.ts",
    "backend-api/integrations/catalog/catalog.json",
    "backend-api/integrations/services/integrationsService.ts",
    "docs/guides/integrations/acme-cloud.mdx",
    "docs/docs.json",
  ]) {
    const absolutePath = path.join(root, file);
    const source = fs.readFileSync(absolutePath, "utf8");
    assert.equal(
      source,
      await prettier.format(source, { filepath: absolutePath, printWidth: 100 }),
      `${file} should be generated in repository format`,
    );
  }
  assert.deepEqual(validateExtensions(root).errors, []);
});

test("extension validator rejects an imported provider that is not registered", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await scaffoldIntegration({
    root,
    id: "acme-cloud",
    name: "Acme Cloud",
    primaryEnv: "ACME_API_KEY",
    testUrl: "https://api.acme.example/v1/me",
  });

  const servicePath = path.join(root, "backend-api/integrations/services/integrationsService.ts");
  const service = fs.readFileSync(servicePath, "utf8");
  fs.writeFileSync(servicePath, service.replace("[acmeCloudProvider].forEach", "[].forEach"));

  assert.ok(
    validateExtensions(root).errors.includes("acme-cloud: acmeCloudProvider is not registered"),
  );
});

test("integration scaffolder validates without writing in dry-run mode", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await scaffoldIntegration({
    root,
    id: "acme",
    name: "Acme",
    primaryEnv: "ACME_TOKEN",
    testUrl: "https://api.acme.example/me",
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(path.join(root, "backend-api/integrations/providers/acme.ts")), false);
});

test("integration scaffolder refuses duplicate catalog ids", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "backend-api/integrations/catalog/catalog.json"),
    '[{"id":"acme"}]\n',
  );

  await assert.rejects(
    async () =>
      scaffoldIntegration({
        root,
        id: "acme",
        name: "Acme",
        primaryEnv: "ACME_TOKEN",
        testUrl: "https://api.acme.example/me",
      }),
    /already exists/,
  );
});

test("integration scaffolder refuses unknown catalog categories", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "backend-api/integrations/catalog/catalog.json"),
    '[{"id":"existing","category":"developer-tools"}]\n',
  );

  await assert.rejects(
    async () =>
      scaffoldIntegration({
        root,
        id: "acme",
        name: "Acme",
        category: "developer-tool",
        primaryEnv: "ACME_TOKEN",
        testUrl: "https://api.acme.example/me",
      }),
    /--category must be one of: developer-tools/,
  );
});

test("integration scaffolder requires HTTPS provider endpoints", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    async () =>
      scaffoldIntegration({
        root,
        id: "acme",
        name: "Acme",
        primaryEnv: "ACME_TOKEN",
        testUrl: "https://api.acme.example/me",
        credentialsUrl: "http://acme.example/tokens",
      }),
    /--credentials-url must use HTTPS/,
  );
});

test("backend scaffolder creates a fail-closed adapter and contract test", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await scaffoldBackendAdapter({
    root,
    id: "acme-cloud",
    name: "Acme Cloud",
  });
  assert.deepEqual(result.files, [
    "workers/provisioner/backends/acme-cloud.ts",
    "backend-api/__tests__/acme-cloudBackend.test.ts",
  ]);

  const adapter = fs.readFileSync(
    path.join(root, "workers/provisioner/backends/acme-cloud.ts"),
    "utf8",
  );
  assert.match(adapter, /class AcmeCloudBackend extends ProvisionerBackend/);
  assert.match(adapter, /"Acme Cloud backend"/);
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
    assert.match(adapter, new RegExp(`this\\._notImplemented\\("${method}"\\)`));
  }
  assert.doesNotMatch(adapter, /containerManager/);
  const Backend = require(path.join(root, "workers/provisioner/backends/acme-cloud.ts"));
  const backend = new Backend({});
  const calls = [
    ["create", [{ id: "agent-1", name: "test" }]],
    ["destroy", ["runtime-1", { agentId: "agent-1" }]],
    ["status", ["runtime-1"]],
    ["stats", ["runtime-1", { id: "agent-1" }]],
    ["stop", ["runtime-1"]],
    ["start", ["runtime-1"]],
    ["restart", ["runtime-1"]],
    ["logs", ["runtime-1", { follow: false }]],
    ["exec", ["runtime-1", { cmd: ["true"] }]],
  ];
  for (const [method, args] of calls) {
    await assert.rejects(
      backend[method](...args),
      new RegExp(`Acme Cloud backend ${method} is not implemented`),
    );
  }
  for (const file of [
    "workers/provisioner/backends/acme-cloud.ts",
    "backend-api/__tests__/acme-cloudBackend.test.ts",
  ]) {
    const absolutePath = path.join(root, file);
    const source = fs.readFileSync(absolutePath, "utf8");
    assert.equal(
      source,
      await prettier.format(source, { filepath: absolutePath, printWidth: 100 }),
      `${file} should be generated in repository format`,
    );
  }
});

test("backend scaffolder refuses to overwrite an adapter", async (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "workers/provisioner/backends/acme.ts"), "existing\n");
  await assert.rejects(
    async () => scaffoldBackendAdapter({ root, id: "acme", name: "Acme" }),
    /Refusing to overwrite/,
  );
});

test("contributor runner parses explicit scoped checks", () => {
  assert.deepEqual(parseCli(["check", "--scope", "backend-api", "cli"]), {
    command: "check",
    scopes: ["backend-api", "cli"],
    help: false,
  });
});

test("contributor runner maps shared extension paths to focused checks", () => {
  assert.deepEqual(
    scopesForFiles([
      "backend-api/integrations/providers/acme.ts",
      "backend-api/__tests__/providers/acmeProvider.test.ts",
      "docs/guides/integrations/acme.mdx",
      "e2e/integrations/.env.providers.example",
      "workers/provisioner/backends/acme.ts",
      "backend-api/__tests__/acmeBackend.test.ts",
      "cli/src/index.js",
    ]),
    ["integrations", "backend-adapters", "cli"],
  );
});

test("contributor runner preserves deleted paths for subsystem routing", () => {
  assert.deepEqual(
    normalizeChangedPaths([
      "backend-api/__tests__/deleted.test.ts",
      "workers/provisioner/backends/removed.ts",
      "backend-api/__tests__/deleted.test.ts",
    ]),
    ["backend-api/__tests__/deleted.test.ts", "workers/provisioner/backends/removed.ts"],
  );
  assert.deepEqual(
    scopesForFiles([
      "backend-api/__tests__/deleted.test.ts",
      "workers/provisioner/backends/removed.ts",
    ]),
    ["backend-api", "backend-adapters"],
  );
});

test("targeted setup installs root tooling and the selected package", () => {
  assert.deepEqual(packagesForSetup(["cli"]), ["root", "cli"]);
  assert.deepEqual(packagesForSetup(["integrations"]), ["root", "backend-api"]);
  assert.deepEqual(packagesForSetup(["backend-adapters"]), [
    "root",
    "backend-api",
    "worker-provisioner",
  ]);
});

test("contributor runner rejects unknown scopes", () => {
  assert.throws(() => normalizeScopes(["unknown-area"], "check", []), /Unknown scope/);
});

test("current extension registry satisfies the public validator", () => {
  const result = validateExtensions(REPO_ROOT);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.catalogProviders >= 69);
  assert.equal(result.backendContractMethods, 9);
});
