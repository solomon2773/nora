import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const knownSafeValues = new Map([
  [
    "ENCRYPTION_KEY",
    new Set([
      "<REPLACE_WITH_64_HEX_CHARS>",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ]),
  ],
  ["PROXMOX_API_URL", new Set(["", "<REPLACE_WITH_PROXMOX_URL>"])],
  ["NVIDIA_API_KEY", new Set(["", "<REPLACE_WITH_NVIDIA_API_KEY>"])],
]);

function getTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldScanFile(filePath) {
  const baseName = path.basename(filePath);
  return (
    baseName.startsWith(".env") ||
    baseName.endsWith(".env") ||
    baseName.endsWith(".example") ||
    baseName.endsWith(".sample")
  );
}

function normalizeValue(rawValue) {
  return rawValue.replace(/\s*#.*$/, "").trim();
}

function isAllowedValue(key, value, filePath) {
  if (knownSafeValues.get(key)?.has(value)) {
    return true;
  }

  if (value.startsWith("<") && value.endsWith(">")) {
    return true;
  }

  if (key === "ENCRYPTION_KEY" && filePath === ".env.test") {
    return value === "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }

  return false;
}

function scanFile(filePath) {
  let content = "";

  try {
    content = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
  } catch {
    return [];
  }

  const violations = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*(PROXMOX_API_URL|NVIDIA_API_KEY|ENCRYPTION_KEY)\s*=\s*(.*)\s*$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = normalizeValue(rawValue);

    if (isAllowedValue(key, value, filePath)) {
      continue;
    }

    violations.push({
      filePath,
      key,
      lineNumber: index + 1,
    });
  }

  return violations;
}

const violations = getTrackedFiles()
  .filter((filePath) => shouldScanFile(filePath))
  .flatMap((filePath) => scanFile(filePath));

if (violations.length > 0) {
  console.error("Sensitive configuration scan failed.");
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber} contains ${violation.key}`);
  }
  process.exit(1);
}

console.log("Sensitive configuration scan passed.");
