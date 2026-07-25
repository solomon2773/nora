#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_DIRS = new Map([
  ["root", "."],
  ["admin-dashboard", "admin-dashboard"],
  ["agent-runtime", "agent-runtime"],
  ["backend-api", "backend-api"],
  ["cli", "cli"],
  ["e2e", "e2e"],
  ["frontend-dashboard", "frontend-dashboard"],
  ["frontend-marketing", "frontend-marketing"],
  ["mcp-server", "mcp-server"],
  ["worker-backup", "workers/backup"],
  ["worker-provisioner", "workers/provisioner"],
]);

const CHECK_SCOPES = [
  "root",
  "integrations",
  "backend-adapters",
  ...[...PACKAGE_DIRS.keys()].filter((scope) => scope !== "root" && scope !== "backend-api"),
  "backend-api",
];

function printHelp(command = "") {
  const usage = command
    ? `npm run contributor:${command === "setup" ? "setup" : "check"} -- [scope ...]`
    : "npm run contributor:setup -- [scope ...]\n  npm run contributor:check -- [scope ...]";
  process.stdout.write(`Usage:
  ${usage}

Scopes:
  all, root, integrations, backend-adapters,
  admin-dashboard, agent-runtime, backend-api, cli, e2e,
  frontend-dashboard, frontend-marketing, mcp-server,
  worker-backup, worker-provisioner

Setup installs exact lockfile dependencies. With no scope it installs every package.
Check infers scopes from branch and working-tree changes. Pass scopes to override detection.
Live Docker, cloud, credential, and Playwright browser checks remain explicit.
`);
}

function run(command, args, cwd = ROOT) {
  process.stdout.write(
    `\n> (${path.relative(ROOT, cwd) || "root"}) ${command} ${args.join(" ")}\n`,
  );
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function gitLines(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeChangedPaths(paths = []) {
  return [...new Set(paths.filter(Boolean))].sort();
}

export function changedFiles() {
  const files = new Set([
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMRD"]),
    ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
  const mergeBase = gitLines(["merge-base", "HEAD", "origin/master"])[0];
  if (mergeBase) {
    for (const file of gitLines([
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      `${mergeBase}...HEAD`,
    ])) {
      files.add(file);
    }
  }
  return normalizeChangedPaths([...files]);
}

export function scopesForFiles(files) {
  const scopes = new Set();
  for (const file of files) {
    if (
      file.startsWith("backend-api/integrations/") ||
      file.startsWith("backend-api/__tests__/providers/") ||
      file.startsWith("docs/guides/integrations/") ||
      file === "e2e/integrations/.env.providers.example"
    ) {
      scopes.add("integrations");
    } else if (/^backend-api\/__tests__\/[^/]+Backend\.test\.ts$/.test(file)) {
      scopes.add("backend-adapters");
    } else if (file.startsWith("workers/provisioner/backends/")) scopes.add("backend-adapters");
    else if (file.startsWith("backend-api/")) scopes.add("backend-api");
    else if (file.startsWith("agent-runtime/")) scopes.add("agent-runtime");
    else if (file.startsWith("workers/provisioner/")) scopes.add("worker-provisioner");
    else if (file.startsWith("workers/backup/")) scopes.add("worker-backup");
    else if (file.startsWith("admin-dashboard/")) scopes.add("admin-dashboard");
    else if (file.startsWith("frontend-dashboard/")) scopes.add("frontend-dashboard");
    else if (file.startsWith("frontend-marketing/")) scopes.add("frontend-marketing");
    else if (file.startsWith("e2e/")) scopes.add("e2e");
    else if (file.startsWith("cli/")) scopes.add("cli");
    else if (file.startsWith("mcp-server/")) scopes.add("mcp-server");
    else scopes.add("root");
  }
  if (scopes.size === 0) scopes.add("root");
  return [...scopes];
}

export function normalizeScopes(rawScopes, command, files) {
  const requested = rawScopes.flatMap((scope) => scope.split(",")).filter(Boolean);
  const scopes =
    requested.length > 0 ? requested : command === "setup" ? ["all"] : scopesForFiles(files);
  const valid = new Set(["all", ...CHECK_SCOPES]);
  for (const scope of scopes) {
    if (!valid.has(scope)) throw new Error(`Unknown scope: ${scope}`);
  }
  if (scopes.includes("all")) {
    return [...PACKAGE_DIRS.keys()];
  }
  return [...new Set(scopes)];
}

export function packagesForSetup(scopes) {
  const packages = new Set(["root"]);
  for (const scope of scopes) {
    if (scope === "integrations") {
      packages.add("root");
      packages.add("backend-api");
    } else if (scope === "backend-adapters") {
      packages.add("root");
      packages.add("backend-api");
      packages.add("worker-provisioner");
    } else {
      packages.add(scope);
    }
  }
  return [...packages];
}

function setupScopes(scopes) {
  for (const scope of packagesForSetup(scopes)) {
    const directory = PACKAGE_DIRS.get(scope);
    if (!directory) throw new Error(`No install package is mapped for ${scope}`);
    run("npm", ["ci"], path.join(ROOT, directory));
  }
}

function packageScript(directory, script, extra = []) {
  run(
    "npm",
    ["run", script, ...(extra.length ? ["--", ...extra] : [])],
    path.join(ROOT, directory),
  );
}

function runChangedFormatting(files) {
  const existingFiles = files.filter((file) => fs.existsSync(path.join(ROOT, file)));
  if (existingFiles.length === 0) return;
  const lint = existingFiles.filter((file) => /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file));
  const format = existingFiles.filter((file) =>
    /\.(?:[cm]?js|jsx|ts|tsx|css|json|ya?ml|mdx?)$/.test(file),
  );
  if (lint.length > 0) packageScript(".", "ci:lint", lint);
  if (format.length > 0) packageScript(".", "ci:format:check", format);
}

function runExtensionChecks() {
  run("node", ["scripts/validate-extension-scaffolds.mjs"]);
  run("node", ["--test", "scripts/extension-scaffolds.test.mjs"]);
}

function checkScopes(scopes, files) {
  runChangedFormatting(files);
  packageScript(".", "ci:secret-scan");
  if (
    files.some((file) =>
      /^(?:infra\/|\.github\/workflows\/|docker-compose|nginx|setup\.(?:sh|ps1)$)/.test(file),
    )
  ) {
    packageScript(".", "ci:validate-infra");
  }
  let extensionsChecked = false;
  for (const scope of scopes) {
    process.stdout.write(`\n== ${scope} ==\n`);
    if (["root", "integrations", "backend-adapters"].includes(scope) && !extensionsChecked) {
      runExtensionChecks();
      extensionsChecked = true;
    }
    if (scope === "root") continue;
    if (scope === "integrations") {
      packageScript("backend-api", "typecheck");
      packageScript("backend-api", "test", ["--runInBand", "__tests__/providers"]);
    } else if (scope === "backend-adapters") {
      packageScript("workers/provisioner", "typecheck");
      packageScript("backend-api", "typecheck");
      const generatedContractTests = files
        .filter((file) => /^backend-api\/__tests__\/[^/]+Backend\.test\.ts$/.test(file))
        .filter((file) => fs.existsSync(path.join(ROOT, file)))
        .map((file) => file.slice("backend-api/".length));
      packageScript("backend-api", "test", [
        "--runInBand",
        "__tests__/backendCatalog.test.ts",
        "__tests__/proxmoxCatalog.test.ts",
        ...generatedContractTests,
      ]);
    } else if (scope === "backend-api") {
      packageScript("backend-api", "typecheck");
      packageScript("backend-api", "test", ["--runInBand"]);
    } else if (scope === "agent-runtime") {
      packageScript("agent-runtime", "typecheck");
      packageScript("agent-runtime", "test");
    } else if (scope === "cli") {
      packageScript("cli", "test");
    } else if (scope === "mcp-server") {
      packageScript("mcp-server", "typecheck");
      packageScript("mcp-server", "test");
    } else {
      packageScript(PACKAGE_DIRS.get(scope), "typecheck");
    }
  }
}

export function parseCli(argv) {
  const command = argv[0];
  const scopes = [];
  let help = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--scope") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--scope requires a value");
      scopes.push(value);
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else scopes.push(arg);
  }
  return { command, scopes, help };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, scopes: rawScopes, help } = parseCli(argv);
    if (help || !["setup", "check"].includes(command)) {
      printHelp(command);
      return !help && command ? 1 : 0;
    }

    const files = changedFiles();
    const scopes = normalizeScopes(rawScopes, command, files);
    process.stdout.write(
      `${command === "setup" ? "Installing" : "Checking"}: ${scopes.join(", ")}\n`,
    );
    if (command === "setup") setupScopes(scopes);
    else checkScopes(scopes, files);
    process.stdout.write(`\nContributor ${command} completed successfully.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Contributor command failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
