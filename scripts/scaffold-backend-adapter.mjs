#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertOption(condition, message) {
  if (!condition) throw new Error(message);
}

function toPascalCase(value) {
  return String(value)
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

async function formatWrites(writes) {
  let prettier;
  try {
    prettier = await import("prettier");
  } catch {
    throw new Error(
      "Prettier is required to generate repository-ready files. Run npm run contributor:setup -- --scope root first.",
    );
  }
  const formatted = new Map();
  for (const [file, contents] of writes) {
    formatted.set(file, await prettier.format(contents, { filepath: file, printWidth: 100 }));
  }
  return formatted;
}

function adapterSource({ id, name, className }) {
  return `// @ts-nocheck
// ${name} deploy-target adapter scaffold.
// This file is intentionally not registered until every lifecycle method is implemented and tested.

const ProvisionerBackend = require("./interface");

class ${className}Backend extends ProvisionerBackend {
  constructor(options = {}) {
    super();
    this.options = { ...options };
  }

  _notImplemented(operation) {
    throw new Error(${JSON.stringify(`${name} backend`)} + \` \${operation} is not implemented\`);
  }

  async create(_config) {
    this._notImplemented("create");
  }

  async destroy(_containerId, _options = {}) {
    this._notImplemented("destroy");
  }

  async status(_containerId) {
    this._notImplemented("status");
  }

  async stats(_containerId, _agent = null) {
    this._notImplemented("stats");
  }

  async stop(_containerId) {
    this._notImplemented("stop");
  }

  async start(_containerId) {
    this._notImplemented("start");
  }

  async restart(_containerId) {
    this._notImplemented("restart");
  }

  async logs(_containerId, _options = {}) {
    this._notImplemented("logs");
  }

  async exec(_containerId, _options = {}) {
    this._notImplemented("exec");
  }
}

module.exports = ${className}Backend;
`;
}

function contractTestSource({ id, name, className }) {
  return `// @ts-nocheck
const ${className}Backend = require("../../workers/provisioner/backends/${id}");
const ProvisionerBackend = require("../../workers/provisioner/backends/interface");

describe(${JSON.stringify(`${name} backend contract`)}, () => {
  it("extends the shared provisioner interface", () => {
    const backend = new ${className}Backend({});
    expect(backend).toBeInstanceOf(ProvisionerBackend);
    const methods = [
      "create",
      "destroy",
      "status",
      "stats",
      "stop",
      "start",
      "restart",
      "logs",
      "exec",
    ];
    for (const method of methods) {
      expect(typeof backend[method]).toBe("function");
    }
  });

  it("fails closed until every required operation is implemented", async () => {
    const backend = new ${className}Backend({});
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
      await expect(backend[method](...args)).rejects.toThrow(
        ${JSON.stringify(`${name} backend`)} + " " + method + " is not implemented",
      );
    }
  });

  it.todo("creates a runtime and returns stable containerId/host metadata");
  it.todo("implements idempotent destroy and accurate status");
  it.todo("implements stop/start/restart lifecycle operations");
  it.todo("normalizes telemetry and documents unavailable capabilities");
  it.todo("covers logs and interactive exec when the target supports them");
});
`;
}

export async function scaffoldBackendAdapter(options) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const id = String(options.id || "").trim();
  const name = String(options.name || "").trim();
  assertOption(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id), "--id must be kebab-case");
  assertOption(name.length > 0, "--name is required");

  const className = toPascalCase(id);
  const files = new Map([
    [
      path.join(root, "workers", "provisioner", "backends", `${id}.ts`),
      adapterSource({ id, name, className }),
    ],
    [
      path.join(root, "backend-api", "__tests__", `${id}Backend.test.ts`),
      contractTestSource({ id, name, className }),
    ],
  ]);

  for (const file of files.keys()) {
    assertOption(
      !fs.existsSync(file),
      `Refusing to overwrite existing file: ${path.relative(root, file)}`,
    );
  }

  const formattedFiles = await formatWrites(files);

  if (!options.dryRun) {
    for (const [file, contents] of formattedFiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, "utf8");
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    files: [...formattedFiles.keys()].map((file) => path.relative(root, file)),
    nextSteps: [
      "Implement and unit-test every lifecycle operation; the generated adapter fails closed.",
      "Add the deploy target to agent-runtime/lib/backendCatalog.ts and selection validation.",
      "Wire worker provisioning plus backend-api/containerManager.ts lifecycle resolution.",
      "Add admin configuration, operator selection, env/setup, docs, and e2e coverage.",
      "Review both backend-api and worker consumers because this folder is shared/mounted.",
      "Run npm run contributor:check -- backend-adapters.",
    ],
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--id" || arg === "--name") {
      const value = argv[index + 1];
      assertOption(value && !value.startsWith("--"), `${arg} requires a value`);
      options[arg === "--id" ? "id" : "name"] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:
  npm run scaffold:backend -- --id acme-cloud --name "Acme Cloud"

The command creates an unregistered, fail-closed adapter and a contract-test starter.
It does not edit shared routing/catalog files because a deploy target spans the runtime,
backend, worker, UI, setup, documentation, and e2e contracts.

Options:
  --dry-run  Validate and list files without writing
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const result = await scaffoldBackendAdapter(options);
      process.stdout.write(
        `${result.dryRun ? "Would create" : "Created"}:\n${result.files.map((file) => `  - ${file}`).join("\n")}\n\nRequired integration work:\n${result.nextSteps.map((step) => `  - ${step}`).join("\n")}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Backend scaffold failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
