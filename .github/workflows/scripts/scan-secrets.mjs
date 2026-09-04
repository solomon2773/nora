// Repo-wide credential scan.
//
// This is the companion to scan-sensitive-config.mjs, which enforces
// placeholder discipline for three keys inside .env-shaped files. That check is
// deliberately narrow, and the gap was wide: a real JWT_SECRET, a Stripe live
// key, an AWS key, or a private key committed in any .ts/.yml/.md file passed
// the "Sensitive config scan" gate untouched.
//
// GitHub secret scanning with push protection covers well-known *provider*
// token shapes, and it stays the first line of defence. It does not cover
// Nora's own secret material — JWT_SECRET, ENCRYPTION_KEY, the API-key hash
// secrets, the backup encryption key — because those have no provider-specific
// shape to match. That is what this adds, plus a blocking PR-time gate rather
// than an after-the-fact alert.
//
// Design rule: every pattern here is high-confidence. No generic entropy
// heuristics — an unreliable secret scanner gets muted, and a muted gate is
// worse than none. Findings should be rare and real.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// This scanner and its tests contain every pattern below as literal text.
const SELF_EXCLUDED = new Set([
  ".github/workflows/scripts/scan-secrets.mjs",
  ".github/workflows/scripts/scan-secrets.test.mjs",
]);

const SKIPPED_PATH_SEGMENTS = ["node_modules/", ".next/", "coverage/", "dist/"];
// Test fixtures are fake by construction — hardcoded keys, sequential tokens,
// stub PEM blocks — and flagging them trains people to ignore this gate. Real
// provider tokens committed to a test file are still caught by GitHub secret
// scanning push protection, which is enabled repo-wide.
const TEST_FILE_RE = /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/;
const SKIPPED_BASENAMES = new Set(["package-lock.json"]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".pdf",
  ".mp4",
  ".mov",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".gz",
  ".tgz",
  ".jar",
  ".class",
  ".so",
  ".dylib",
  ".dll",
]);

// Well-known provider credentials. Each requires enough trailing entropy that a
// prose mention of the prefix cannot trip it.
const PROVIDER_PATTERNS = [
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  {
    name: "Slack webhook",
    re: /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g,
  },
  { name: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { name: "OpenAI key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "NVIDIA API key", re: /\bnvapi-[A-Za-z0-9_-]{32,}\b/g },
  { name: "Nora workspace API key", re: /\bnora_[A-Za-z0-9]{32,}\b/g },
  // Requires a real base64 body, so UI label strings ("-----BEGIN OPENSSH
  // PRIVATE KEY-----" as placeholder text) and short test fixtures do not match.
  {
    name: "private key block",
    re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{100,}/g,
  },
];

// Nora's own secret material, detected by assignment rather than by shape.
const SECRET_ASSIGNMENT_KEYS = [
  "JWT_SECRET",
  "ENCRYPTION_KEY",
  "NORA_BACKUP_ENCRYPTION_KEY",
  "NORA_AGENT_HUB_API_KEY_HASH_SECRET",
  "NORA_API_KEY_HASH_SECRET",
  "NORA_GITHUB_TOKEN",
  "NORA_BACKUP_SSH_PASSWORD",
  "NORA_BACKUP_S3_SECRET_ACCESS_KEY",
  "NORA_BACKUP_R2_SECRET_ACCESS_KEY",
  "DB_PASSWORD",
  "REDIS_PASSWORD",
  "DEFAULT_ADMIN_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "PROXMOX_SSH_PASSWORD",
  "PROXMOX_TOKEN_SECRET",
  "SIGNUP_RECAPTCHA_SECRET",
  "SIGNUP_TURNSTILE_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "NVIDIA_API_KEY",
];

// Deliberately absent: *_KEY_FILE, *_KEY_PATH, *_DIR (filesystem locations),
// *_SITE_KEY (reCAPTCHA/Turnstile site keys are public by design), and
// PROXMOX_TOKEN_ID / AWS_ACCESS_KEY_ID (identifiers, not secrets).
const ASSIGNMENT_RE = new RegExp(
  String.raw`\b(${SECRET_ASSIGNMENT_KEYS.join("|")})[ \t]*[:=][ \t]*["']?([^"'\n\r,}\s]+)`,
  "g",
);

const PLACEHOLDER_WORDS = [
  "example",
  "placeholder",
  "redacted",
  "fixture",
  "dummy",
  "sample",
  "changeme",
  "change-me",
  "your-",
  "your_",
  "replace",
  "insert",
  "xxxx",
  "test",
  "fake",
  "notreal",
  "not-real",
  "todo",
  "dev-only",
  "localhost",
  "secret",
  "password",
];

// Values that are checked in on purpose and are not credentials. The .env.test
// key is a fixed all-zero-ish hex string the test suite depends on; it is also
// allowlisted in scan-sensitive-config.mjs, which governs .env-shaped files.
const KNOWN_SAFE_VALUES = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
]);

/**
 * Report whether text carries an obvious not-a-real-secret marker.
 *
 * @param {string} text - Candidate token or assigned value.
 * @returns {boolean} True when a placeholder word appears anywhere in it.
 */
function containsPlaceholderWord(text) {
  const lowered = text.toLowerCase();
  return PLACEHOLDER_WORDS.some((word) => lowered.includes(word));
}

/**
 * Report whether a value has the shape of generated credential material.
 *
 * Real secrets in this codebase are hex or base64 output from a CSPRNG. Code
 * expressions (`crypto.randomBytes(32)`), env indirection (`process.env.X`),
 * shell references (`$JWT_SECRET`), URLs, and function names all fail here,
 * which is what keeps the assignment detector from firing on source code.
 *
 * @param {string} value - Normalized right-hand side of an assignment.
 * @returns {boolean} True when the value looks like random secret material.
 */
function looksLikeCredentialMaterial(value) {
  if (!/^[A-Za-z0-9+/=_-]{12,}$/.test(value)) return false;
  if (value.startsWith("/")) return false;
  // Long enough to be a key regardless of composition, or mixed letters and
  // digits the way generated material is. A bare word like "Read-EnvValue"
  // clears the length bar but has no digits, so it is not credential-shaped.
  if (value.length >= 32) return true;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

/**
 * Decide whether an assigned value is obviously not real credential material.
 *
 * @param {string} value - Raw right-hand side of the assignment.
 * @returns {boolean} True when the value is a placeholder, reference, or stub.
 */
function isPlaceholderValue(value) {
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  if (!normalized) return true;
  // Env indirection and template references are never literal secrets.
  if (/^\$\{?\{?/.test(normalized)) return true;
  if (/^process\.env\b/.test(normalized)) return true;
  if (normalized.startsWith("<") && normalized.endsWith(">")) return true;
  if (normalized.includes("${")) return true;
  // Real secret material is long. Short values are config, flags, or stubs.
  if (normalized.length < 12) return true;
  if (containsPlaceholderWord(normalized)) return true;
  // Repeated single character, e.g. "aaaaaaaaaaaa" or "000000000000".
  if (/^(.)\1+$/.test(normalized)) return true;
  return false;
}

function getTrackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldScanFile(filePath) {
  if (SELF_EXCLUDED.has(filePath)) return false;
  if (SKIPPED_BASENAMES.has(path.basename(filePath))) return false;
  if (SKIPPED_PATH_SEGMENTS.some((segment) => filePath.includes(segment))) return false;
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  if (TEST_FILE_RE.test(filePath)) return false;
  return true;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

/**
 * Scan one tracked file for provider tokens and Nora secret assignments.
 *
 * @param {string} filePath - Repo-relative path to scan.
 * @returns {Array<Object>} Findings with path, line, and detector label.
 */
export function scanContent(filePath, content) {
  const findings = [];

  for (const { name, re } of PROVIDER_PATTERNS) {
    for (const match of content.matchAll(re)) {
      if (containsPlaceholderWord(match[0])) continue;
      findings.push({ filePath, line: lineNumberAt(content, match.index), detector: name });
    }
  }

  for (const match of content.matchAll(ASSIGNMENT_RE)) {
    const [, key, value] = match;
    const normalized = value.trim().replace(/^["']|["']$/g, "");
    if (KNOWN_SAFE_VALUES.has(normalized)) continue;
    if (isPlaceholderValue(value)) continue;
    if (!looksLikeCredentialMaterial(normalized)) continue;
    findings.push({
      filePath,
      line: lineNumberAt(content, match.index),
      detector: `${key} assigned a literal value`,
    });
  }

  return findings;
}

function main() {
  const findings = getTrackedFiles()
    .filter(shouldScanFile)
    .flatMap((filePath) => {
      let content = "";
      try {
        content = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
      } catch {
        return [];
      }
      if (content.includes("\0")) return [];
      return scanContent(filePath, content);
    });

  if (findings.length > 0) {
    console.error("Secret scan failed — remove the credential and rotate it.");
    for (const finding of findings) {
      console.error(`- ${finding.filePath}:${finding.line} — ${finding.detector}`);
    }
    process.exit(1);
  }

  console.log("Secret scan passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
