const { normalizeTemplatePayload } = require("./agentPayloads");

const SENSITIVE_PATH_RE =
  /(^|\/)(\.env(\..+)?|auth-profiles\.json|.*\.(pem|key|p12|pfx)|.*(credential|secret|token).*\.(json|txt|yaml|yml|env)?)$/i;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HIGH_CONFIDENCE_TOKEN_RE =
  /\b(sk-[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/;
const ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|token|secret|password|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`]{8,})/i;
const PLACEHOLDER_RE = /^(your_|example|sample|placeholder|changeme|replace-me|test-|demo-)/i;

function decodeEntryContent(entry) {
  try {
    return Buffer.from(String(entry?.contentBase64 || ""), "base64").toString(
      "utf8"
    );
  } catch {
    return "";
  }
}

function pushIssue(issues, issue) {
  if (issues.length >= 10) return;
  issues.push(issue);
}

function scanTemplatePayloadForSecrets(rawPayload = {}) {
  const payload = normalizeTemplatePayload(rawPayload);
  const issues = [];

  for (const entry of [...payload.files, ...payload.memoryFiles]) {
    const path = entry.path || "unknown";

    if (SENSITIVE_PATH_RE.test(path)) {
      pushIssue(issues, {
        path,
        type: "sensitive_path",
        message: "Remove secret-bearing files such as .env, key, or credential files before publishing.",
      });
    }

    const content = decodeEntryContent(entry);
    if (!content) continue;

    if (PRIVATE_KEY_RE.test(content)) {
      pushIssue(issues, {
        path,
        type: "private_key",
        message: "Private key material was detected in this template.",
      });
      continue;
    }

    if (HIGH_CONFIDENCE_TOKEN_RE.test(content)) {
      pushIssue(issues, {
        path,
        type: "access_token",
        message: "A high-confidence API token or access key was detected in this template.",
      });
      continue;
    }

    if (JWT_RE.test(content)) {
      pushIssue(issues, {
        path,
        type: "jwt",
        message: "A JWT-like token was detected in this template.",
      });
      continue;
    }

    const assignmentMatch = content.match(ASSIGNMENT_RE);
    if (assignmentMatch) {
      const value = assignmentMatch[2] || "";
      if (!PLACEHOLDER_RE.test(value) && !value.includes("<") && !value.includes("{{")) {
        pushIssue(issues, {
          path,
          type: "secret_assignment",
          message: "A secret-like key assignment was detected in this template.",
        });
      }
    }
  }

  return issues;
}

module.exports = {
  scanTemplatePayloadForSecrets,
};
