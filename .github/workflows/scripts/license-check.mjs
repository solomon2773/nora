import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const licenseChecker = require("license-checker");

const deniedLicensePatterns = [
  /\bAGPL\b/i,
  /\bGPL\b/i,
  /\bSSPL\b/i,
  /\bBUSL\b/i,
  /\bCPAL\b/i,
  /\bOSL\b/i,
  /\bRPL\b/i,
  /Commons Clause/i,
  /Elastic License/i,
];

function normalizeLicenseString(value) {
  if (Array.isArray(value)) {
    return value.join(" OR ");
  }

  if (value && typeof value === "object") {
    return Object.values(value).join(" OR ");
  }

  return String(value || "").trim();
}

function isDeniedLicense(license) {
  if (!license) {
    return true;
  }

  return deniedLicensePatterns.some((pattern) => pattern.test(license));
}

async function collectLicenses(packageDir) {
  return new Promise((resolve, reject) => {
    licenseChecker.init(
      {
        start: packageDir,
        production: false,
      },
      (error, packages) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(packages);
      },
    );
  });
}

async function main() {
  const inputDir = process.argv[2];
  if (!inputDir) {
    console.error("Usage: npm run ci:license-check -- <package-dir>");
    process.exit(1);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const packageDir = path.resolve(repoRoot, inputDir);
  const packages = await collectLicenses(packageDir);
  const violations = [];

  for (const [name, metadata] of Object.entries(packages)) {
    const license = normalizeLicenseString(metadata.licenses);
    if (!isDeniedLicense(license)) {
      continue;
    }

    violations.push({
      name,
      license,
      path: metadata.path,
    });
  }

  if (violations.length > 0) {
    console.error(`License policy failed for ${inputDir}.`);
    for (const violation of violations) {
      console.error(`- ${violation.name}: ${violation.license || "UNKNOWN"} (${violation.path})`);
    }
    process.exit(1);
  }

  console.log(`License policy passed for ${inputDir}.`);
}

await main();
