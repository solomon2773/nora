// @ts-nocheck
// Provides the bounded filesystem surface exposed by the agent file API. Every
// runtime command revalidates canonical paths inside an allowlisted root.

const path = require("path");
const { runContainerCommand } = require("./authSync");
const { shellSingleQuote } = require("../agent-runtime/lib/containerCommand");

const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

// Root and path policy

function normalizeRelativePath(rawValue, { allowEmpty = true } = {}) {
  const raw = String(rawValue || "")
    .replace(/\\/g, "/")
    .trim();
  if (!raw) return allowEmpty ? "" : null;

  const normalized = path.posix.normalize(raw).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return allowEmpty ? "" : null;
  if (normalized.startsWith("../")) return null;
  return normalized;
}

/**
 * Describe the filesystem roots Nora exposes for an agent's runtime family,
 * including each root's read/write policy and file-or-directory shape.
 *
 * @param {Object} [agent={}] - Agent whose runtime family selects the roots.
 * @returns {Array} Allowlisted filesystem root descriptors.
 */
function rootsForAgent(agent = {}) {
  if (
    String(agent.runtime_family || "")
      .trim()
      .toLowerCase() === "hermes"
  ) {
    return [
      {
        id: "workspace",
        label: "Workspace",
        path: "/opt/data/workspace",
        access: "rw",
        kind: "directory",
        description: "Primary writable Hermes workspace.",
      },
      {
        id: "runtime-home",
        label: "Runtime Home",
        path: "/opt/data",
        access: "ro",
        kind: "directory",
        description: "Hermes runtime home and support files.",
      },
      {
        id: "logs",
        label: "Logs",
        path: "/opt/data/logs",
        access: "ro",
        kind: "directory",
        description: "Hermes runtime logs.",
      },
    ];
  }

  return [
    {
      id: "workspace",
      label: "Workspace",
      path: "/root/.openclaw/workspace",
      access: "rw",
      kind: "directory",
      description: "Primary writable OpenClaw workspace.",
    },
    {
      id: "openclaw-config",
      label: "OpenClaw Config",
      path: "/root/.openclaw/openclaw.json",
      access: "rw",
      kind: "file",
      description: "Dedicated writable access to the main OpenClaw config file.",
    },
    {
      id: "agent-runtime",
      label: "Agent Runtime",
      path: "/root/.openclaw",
      access: "ro",
      kind: "directory",
      description:
        "Read-only OpenClaw runtime home, including agent files, sessions, and support state.",
    },
  ];
}

function resolveRoot(agent, rootId) {
  const root = rootsForAgent(agent).find((candidate) => candidate.id === rootId);
  if (!root) {
    const error = new Error("Unsupported file root");
    error.statusCode = 400;
    throw error;
  }
  return root;
}

function isFileRoot(root) {
  return String(root?.kind || "directory") === "file";
}

function fileRootRelativeName(root) {
  return path.posix.basename(String(root?.path || ""));
}

/**
 * Resolve a relative path within an allowlisted root without accepting parent
 * traversal or additional paths beneath a dedicated single-file root.
 *
 * @param {Object} root - Allowlisted root descriptor.
 * @param {string} [relativePath=""] - User-supplied path within the root.
 * @param {Object} [options={}] - Whether the empty root path is allowed.
 * @returns {string} Absolute runtime path constrained to the selected root.
 */
function resolveAbsolutePath(root, relativePath = "", { allowEmpty = true } = {}) {
  const normalized = normalizeRelativePath(relativePath, { allowEmpty });
  if (normalized == null) {
    const error = new Error("Invalid file path");
    error.statusCode = 400;
    throw error;
  }
  if (isFileRoot(root)) {
    if (!normalized) return root.path;
    if (normalized === fileRootRelativeName(root)) return root.path;
    const error = new Error("This filesystem root only exposes its dedicated config file");
    error.statusCode = 403;
    throw error;
  }
  return normalized ? path.posix.join(root.path, normalized) : root.path;
}

function isPathWritable(root, relativePath = "") {
  if (root.access !== "rw") return false;
  if (!isFileRoot(root)) return true;
  const normalized = normalizeRelativePath(relativePath, { allowEmpty: true });
  if (normalized == null) return false;
  return !normalized || normalized === fileRootRelativeName(root);
}

function assertWritableRoot(root, relativePath = "", operation = "write") {
  if (root.access === "rw") return;
  const error = new Error("This filesystem root is read-only");
  error.statusCode = 403;
  throw error;
}

/**
 * Enforce root write policy, including the restricted operations supported by
 * OpenClaw's dedicated single-file configuration root.
 *
 * @param {Object} root - Root receiving the mutation.
 * @param {string} [relativePath=""] - Requested target inside the root.
 * @param {string} [operation="write"] - Mutation being attempted.
 * @returns {void}
 */
function assertWritableTarget(root, relativePath = "", operation = "write") {
  assertWritableRoot(root, relativePath, operation);

  if (!isFileRoot(root)) return;
  if (operation !== "write") {
    const error = new Error(
      "This filesystem root only supports editing and downloading the OpenClaw config file",
    );
    error.statusCode = 403;
    throw error;
  }
  if (isPathWritable(root, relativePath)) return;

  const error = new Error("Only openclaw.json can be edited from this filesystem root");
  error.statusCode = 403;
  throw error;
}

function mapFileCommandError(error) {
  const message = String(error?.message || "");

  if (message.includes("__NORA_ACCESS_DENIED__")) {
    const nextError = new Error("Requested path is outside the allowed filesystem root");
    nextError.statusCode = 403;
    return nextError;
  }
  if (message.includes("__NORA_NOT_FOUND__")) {
    const nextError = new Error("Requested path was not found");
    nextError.statusCode = 404;
    return nextError;
  }
  if (message.includes("__NORA_NOT_DIRECTORY__")) {
    const nextError = new Error("Requested path is not a directory");
    nextError.statusCode = 400;
    return nextError;
  }
  if (message.includes("__NORA_NOT_FILE__")) {
    const nextError = new Error("Requested path is not a file");
    nextError.statusCode = 400;
    return nextError;
  }
  if (message.includes("__NORA_TOO_LARGE__")) {
    const nextError = new Error("File is too large for inline preview");
    nextError.statusCode = 413;
    return nextError;
  }

  return error;
}

// Guarded runtime command execution

/**
 * Run a filesystem command and translate internal sentinel failures into
 * stable HTTP-shaped errors without exposing raw runtime details.
 *
 * @param {Object} agent - Agent whose runtime executes the command.
 * @param {string} command - Guarded shell command.
 * @param {Object} [options={}] - Runtime command options.
 * @returns {Promise<Object>} Runtime command result.
 */
async function runFileCommand(agent, command, options = {}) {
  try {
    return await runContainerCommand(agent, command, options);
  } catch (error) {
    throw mapFileCommandError(error);
  }
}

/**
 * Build a shell guard that resolves symlinks and rejects targets escaping the
 * canonical allowlisted root.
 *
 * @param {Object} options - Root, target, and missing-target behavior.
 * @returns {string} Shell fragment that defines validated root and target paths.
 */
function buildInsideRootGuard({ rootPath, targetPath, missingTargetUsesParent = false }) {
  return [
    `root_path=${shellSingleQuote(rootPath)}`,
    `target_path=${shellSingleQuote(targetPath)}`,
    'root_real="$(readlink -f "$root_path")"',
    '[ -n "$root_real" ] || { echo "__NORA_ACCESS_DENIED__"; exit 23; }',
    missingTargetUsesParent
      ? 'if [ -e "$target_path" ]; then target_real="$(readlink -f "$target_path")"; else parent_real="$(readlink -f "$(dirname "$target_path")")"; target_real="$parent_real"; fi'
      : 'target_real="$(readlink -f "$target_path")"',
    '[ -n "$target_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'case "$target_real" in "$root_real"|"$root_real"/*) ;; *) echo "__NORA_ACCESS_DENIED__"; exit 23 ;; esac',
  ].join("\n");
}

// Filesystem reads

/**
 * List one allowlisted directory or expose a dedicated file root as one entry.
 *
 * @param {Object} agent - Agent whose runtime should be inspected.
 * @param {string} rootId - Allowlisted root identifier.
 * @param {string} [relativePath=""] - Directory path within the root.
 * @returns {Promise<Object>} Root metadata and sorted entries.
 */
async function listFiles(agent, rootId, relativePath = "") {
  const root = resolveRoot(agent, rootId);
  const absolutePath = resolveAbsolutePath(root, relativePath);

  if (isFileRoot(root)) {
    const command = [
      "set -eu",
      buildInsideRootGuard({
        rootPath: root.path,
        targetPath: absolutePath,
      }),
      '[ -f "$target_real" ] || { echo "__NORA_NOT_FILE__"; exit 26; }',
      'printf "%s\\0f\\0" "$(basename "$target_real")"',
      'printf "%s\\0" "$(stat -c %s "$target_real")"',
      'printf "%s\\0" "$(stat -c %Y "$target_real")"',
    ].join("\n");

    const { output } = await runFileCommand(agent, command, { timeout: 30000 });
    const segments = output.split("\u0000").filter((segment) => segment.length > 0);
    const name = segments[0] || fileRootRelativeName(root);
    const size = Number.parseInt(segments[2], 10) || 0;
    const mtime = Number.parseFloat(segments[3]);
    const entryPath = fileRootRelativeName(root);

    return {
      root: {
        id: root.id,
        label: root.label,
        access: root.access,
        path: root.path,
        kind: root.kind || "directory",
      },
      path: "",
      entries: [
        {
          name,
          path: entryPath,
          type: "file",
          size,
          mtime: Number.isFinite(mtime) ? new Date(mtime * 1000).toISOString() : null,
          writable: isPathWritable(root, entryPath),
        },
      ],
    };
  }

  const command = [
    "set -eu",
    buildInsideRootGuard({
      rootPath: root.path,
      targetPath: absolutePath,
    }),
    '[ -d "$target_real" ] || { echo "__NORA_NOT_DIRECTORY__"; exit 25; }',
    'find "$target_real" -mindepth 1 -maxdepth 1 -printf "%P\\0%y\\0%s\\0%T@\\0"',
  ].join("\n");

  const { output } = await runFileCommand(agent, command, { timeout: 30000 });
  const segments = output.split("\u0000").filter((segment) => segment.length > 0);
  const entries = [];

  for (let index = 0; index < segments.length; index += 4) {
    const name = segments[index];
    const type = segments[index + 1];
    const size = Number.parseInt(segments[index + 2], 10) || 0;
    const mtime = Number.parseFloat(segments[index + 3]);
    const entryPath = normalizeRelativePath(relativePath ? `${relativePath}/${name}` : name, {
      allowEmpty: false,
    });

    if (!entryPath) continue;

    entries.push({
      name,
      path: entryPath,
      type: type === "d" ? "directory" : "file",
      size,
      mtime: Number.isFinite(mtime) ? new Date(mtime * 1000).toISOString() : null,
      writable: isPathWritable(root, entryPath),
    });
  }

  return {
    root: {
      id: root.id,
      label: root.label,
      access: root.access,
      path: root.path,
      kind: root.kind || "directory",
    },
    path: normalizeRelativePath(relativePath) || "",
    entries: entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    }),
  };
}

/**
 * Read a file as base64 after canonical containment checks, rejecting inline
 * previews larger than the configured size limit.
 *
 * @param {Object} agent - Agent whose runtime owns the file.
 * @param {string} rootId - Allowlisted root identifier.
 * @param {string} [relativePath=""] - File path within the root.
 * @returns {Promise<Object>} File metadata and base64 content.
 */
async function readFile(agent, rootId, relativePath = "") {
  const root = resolveRoot(agent, rootId);
  const absolutePath = resolveAbsolutePath(root, relativePath, {
    allowEmpty: false,
  });

  const command = [
    "set -eu",
    buildInsideRootGuard({
      rootPath: root.path,
      targetPath: absolutePath,
    }),
    '[ -f "$target_real" ] || { echo "__NORA_NOT_FILE__"; exit 26; }',
    'size="$(stat -c %s "$target_real")"',
    `if [ "$size" -gt ${MAX_INLINE_FILE_BYTES} ]; then echo "__NORA_TOO_LARGE__"; exit 27; fi`,
    'mode="$(stat -c %a "$target_real")"',
    'printf "%s\\0%s\\0" "$size" "$mode"',
    'base64 "$target_real" | tr -d "\\n"',
  ].join("\n");

  const { output } = await runFileCommand(agent, command, { timeout: 30000 });
  const firstNull = output.indexOf("\u0000");
  const secondNull = output.indexOf("\u0000", firstNull + 1);

  const size = Number.parseInt(output.slice(0, firstNull), 10) || 0;
  const mode = output.slice(firstNull + 1, secondNull) || "644";
  const contentBase64 = output.slice(secondNull + 1);

  return {
    root: root.id,
    path: normalizeRelativePath(relativePath, { allowEmpty: false }),
    size,
    mode,
    contentBase64,
    writable: isPathWritable(root, relativePath),
  };
}

// Filesystem mutations

/**
 * Atomically replace a writable file through a guarded temporary-file rename.
 *
 * @param {Object} agent - Agent whose runtime receives the file.
 * @param {string} rootId - Writable root identifier.
 * @param {string} [relativePath=""] - Target file path within the root.
 * @param {string} [contentBase64=""] - Base64-encoded file content.
 * @param {number} [mode=0o644] - File mode applied before installation.
 * @returns {Promise<Object>} Success result.
 */
async function writeFile(agent, rootId, relativePath = "", contentBase64 = "", mode = 0o644) {
  const root = resolveRoot(agent, rootId);
  assertWritableTarget(root, relativePath, "write");
  const absolutePath = resolveAbsolutePath(root, relativePath, {
    allowEmpty: false,
  });
  const numericMode = Number.isInteger(mode) ? mode : 0o644;

  const command = [
    "set -eu",
    `root_path=${shellSingleQuote(root.path)}`,
    `target_path=${shellSingleQuote(absolutePath)}`,
    'root_real="$(readlink -f "$root_path")"',
    'parent_real="$(readlink -f "$(dirname "$target_path")")"',
    '[ -n "$root_real" ] || { echo "__NORA_ACCESS_DENIED__"; exit 23; }',
    '[ -n "$parent_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'case "$parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "__NORA_ACCESS_DENIED__"; exit 23 ;; esac',
    'mkdir -p "$(dirname "$target_path")"',
    'tmp_path="${target_path}.nora-tmp.$$"',
    `printf '%s' ${shellSingleQuote(contentBase64)} | base64 -d > "$tmp_path"`,
    `chmod ${numericMode.toString(8)} "$tmp_path"`,
    'mv "$tmp_path" "$target_path"',
  ].join("\n");

  await runFileCommand(agent, command, { timeout: 30000 });
  return { success: true };
}

/**
 * Create a directory only after validating both its parent and resulting
 * canonical path remain inside a writable root.
 *
 * @param {Object} agent - Agent whose runtime receives the directory.
 * @param {string} rootId - Writable root identifier.
 * @param {string} [relativePath=""] - Directory path within the root.
 * @returns {Promise<Object>} Success result.
 */
async function createDirectory(agent, rootId, relativePath = "") {
  const root = resolveRoot(agent, rootId);
  assertWritableTarget(root, relativePath, "mkdir");
  const absolutePath = resolveAbsolutePath(root, relativePath, {
    allowEmpty: false,
  });

  const command = [
    "set -eu",
    `root_path=${shellSingleQuote(root.path)}`,
    `target_path=${shellSingleQuote(absolutePath)}`,
    'root_real="$(readlink -f "$root_path")"',
    'parent_real="$(readlink -f "$(dirname "$target_path")")"',
    '[ -n "$root_real" ] || { echo "__NORA_ACCESS_DENIED__"; exit 23; }',
    '[ -n "$parent_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'case "$parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "__NORA_ACCESS_DENIED__"; exit 23 ;; esac',
    'mkdir -p "$target_path"',
    'target_real="$(readlink -f "$target_path")"',
    'case "$target_real" in "$root_real"|"$root_real"/*) ;; *) echo "__NORA_ACCESS_DENIED__"; exit 23 ;; esac',
  ].join("\n");

  await runFileCommand(agent, command, { timeout: 30000 });
  return { success: true };
}

/**
 * Move a path after canonical containment checks on the source and
 * destination parent.
 *
 * @param {Object} agent - Agent whose runtime owns the path.
 * @param {string} rootId - Writable root identifier.
 * @param {string} [fromPath=""] - Existing source path.
 * @param {string} [toPath=""] - Destination path.
 * @returns {Promise<Object>} Success result.
 */
async function movePath(agent, rootId, fromPath = "", toPath = "") {
  const root = resolveRoot(agent, rootId);
  assertWritableTarget(root, fromPath, "move");
  const absoluteFromPath = resolveAbsolutePath(root, fromPath, { allowEmpty: false });
  const absoluteToPath = resolveAbsolutePath(root, toPath, { allowEmpty: false });

  const command = [
    "set -eu",
    buildInsideRootGuard({
      rootPath: root.path,
      targetPath: absoluteFromPath,
    }),
    `dest_path=${shellSingleQuote(absoluteToPath)}`,
    'dest_parent_real="$(readlink -f "$(dirname "$dest_path")")"',
    '[ -n "$dest_parent_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'case "$dest_parent_real" in "$root_real"|"$root_real"/*) ;; *) echo "__NORA_ACCESS_DENIED__"; exit 23 ;; esac',
    'mkdir -p "$(dirname "$dest_path")"',
    'mv "$target_real" "$dest_path"',
  ].join("\n");

  await runFileCommand(agent, command, { timeout: 30000 });
  return { success: true };
}

/**
 * Recursively delete a non-root target after writable-root and canonical-path checks.
 *
 * @param {Object} agent - Agent whose runtime owns the target.
 * @param {string} rootId - Writable root identifier.
 * @param {string} [relativePath=""] - File or directory to remove.
 * @returns {Promise<Object>} Success result.
 */
async function deletePath(agent, rootId, relativePath = "") {
  const root = resolveRoot(agent, rootId);
  assertWritableTarget(root, relativePath, "delete");
  const normalizedPath = normalizeRelativePath(relativePath, { allowEmpty: false });
  if (!normalizedPath) {
    const error = new Error("A file or folder path is required");
    error.statusCode = 400;
    throw error;
  }
  const absolutePath = resolveAbsolutePath(root, normalizedPath, { allowEmpty: false });

  const command = [
    "set -eu",
    buildInsideRootGuard({
      rootPath: root.path,
      targetPath: absolutePath,
    }),
    '[ -e "$target_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'rm -rf -- "$target_real"',
  ].join("\n");

  await runFileCommand(agent, command, { timeout: 30000 });
  return { success: true };
}

// Download packaging

/**
 * Download a guarded file directly or package a guarded directory as a gzip
 * archive, returning base64 content and attachment metadata.
 *
 * @param {Object} agent - Agent whose runtime owns the target.
 * @param {string} rootId - Allowlisted root identifier.
 * @param {string} [relativePath=""] - File, directory, or root path.
 * @returns {Promise<Object>} Download kind, filename, content type, and base64 payload.
 */
async function downloadPath(agent, rootId, relativePath = "") {
  const root = resolveRoot(agent, rootId);
  const absolutePath = resolveAbsolutePath(root, relativePath);

  const command = [
    "set -eu",
    buildInsideRootGuard({
      rootPath: root.path,
      targetPath: absolutePath,
    }),
    '[ -e "$target_real" ] || { echo "__NORA_NOT_FOUND__"; exit 24; }',
    'if [ -d "$target_real" ]; then',
    '  printf "directory\\0"',
    '  tar -C "$target_real" -czf - . | base64 | tr -d "\\n"',
    "else",
    '  printf "file\\0"',
    '  base64 "$target_real" | tr -d "\\n"',
    "fi",
  ].join("\n");

  const { output } = await runFileCommand(agent, command, { timeout: 120000 });
  const firstNull = output.indexOf("\u0000");
  const kind = output.slice(0, firstNull);
  const contentBase64 = output.slice(firstNull + 1);
  const normalizedPath = normalizeRelativePath(relativePath) || "";
  const name =
    normalizedPath.split("/").filter(Boolean).pop() ||
    (isFileRoot(root) ? fileRootRelativeName(root) : root.id);

  return {
    kind,
    filename: kind === "directory" ? `${name || root.id}.tar.gz` : name || `${root.id}.bin`,
    contentType: kind === "directory" ? "application/gzip" : "application/octet-stream",
    contentBase64,
  };
}

module.exports = {
  MAX_INLINE_FILE_BYTES,
  createDirectory,
  deletePath,
  downloadPath,
  listFiles,
  movePath,
  normalizeRelativePath,
  readFile,
  resolveRoot,
  rootsForAgent,
  writeFile,
  isPathWritable,
};
