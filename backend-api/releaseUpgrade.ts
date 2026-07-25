// @ts-nocheck
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const Docker = require("dockerode");
const { buildAutoUpgrade, buildReleaseInfo } = require("./releaseInfo");

const DEFAULT_STATE_DIR = "/var/lib/nora-upgrade";
const DEFAULT_STATE_VOLUME = "nora_upgrade_state";
const DEFAULT_RUNNER_IMAGE = "docker:29-cli";
const DEFAULT_UPGRADE_REPO = "https://github.com/solomon2773/nora.git";
const DEFAULT_UPGRADE_REF = "master";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_COMPOSE_FILES = ["docker-compose.yml"];
const DEFAULT_LOG_TAIL_LINES = 80;
const DEFAULT_HEALTHCHECK_ATTEMPTS = 221;
const DEFAULT_HEALTHCHECK_INTERVAL_SECONDS = 3;
const LEGACY_HEALTHCHECK_ATTEMPTS = 40;
const LEGACY_HEALTHCHECK_INTERVAL_SECONDS = 3;
const MAX_HEALTHCHECK_WINDOW_SECONDS = 3900;
const DEFAULT_HEALTHCHECK_WINDOW_SECONDS =
  (DEFAULT_HEALTHCHECK_ATTEMPTS - 1) * DEFAULT_HEALTHCHECK_INTERVAL_SECONDS;
const HOST_REPO_MOUNT = "/nora-host-repo";
const RUNNING_PHASES = new Set([
  "queued",
  "fetching",
  "applying",
  "building",
  "health_checking",
  "running",
]);

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// ── Upgrade configuration ───────────────────────────────────────

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBooleanEnv(value, defaultValue = false) {
  const normalized = readString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseHealthcheckInteger(value, fallback, max) {
  const normalized = readString(value);
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

function normalizeHealthcheckBudget(env = process.env, warn = console.warn) {
  let attemptsRaw = readString(env.NORA_UPGRADE_HEALTHCHECK_ATTEMPTS);
  let intervalRaw = readString(env.NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS);
  if (
    attemptsRaw === String(LEGACY_HEALTHCHECK_ATTEMPTS) &&
    intervalRaw === String(LEGACY_HEALTHCHECK_INTERVAL_SECONDS)
  ) {
    attemptsRaw = String(DEFAULT_HEALTHCHECK_ATTEMPTS);
    intervalRaw = String(DEFAULT_HEALTHCHECK_INTERVAL_SECONDS);
  }
  const attempts = parseHealthcheckInteger(
    attemptsRaw,
    DEFAULT_HEALTHCHECK_ATTEMPTS,
    MAX_HEALTHCHECK_WINDOW_SECONDS + 1,
  );
  const intervalSeconds = parseHealthcheckInteger(
    intervalRaw,
    DEFAULT_HEALTHCHECK_INTERVAL_SECONDS,
    MAX_HEALTHCHECK_WINDOW_SECONDS,
  );
  const firstToFinalWindowSeconds =
    attempts === null || intervalSeconds === null ? null : (attempts - 1) * intervalSeconds;

  if (
    attempts === null ||
    intervalSeconds === null ||
    firstToFinalWindowSeconds > MAX_HEALTHCHECK_WINDOW_SECONDS
  ) {
    if (typeof warn === "function") {
      warn(
        `Invalid NORA_UPGRADE health-check overrides (attempts='${attemptsRaw}', interval='${intervalRaw}s'); ` +
          `using ${DEFAULT_HEALTHCHECK_ATTEMPTS} attempts every ${DEFAULT_HEALTHCHECK_INTERVAL_SECONDS}s ` +
          `(${DEFAULT_HEALTHCHECK_WINDOW_SECONDS}s from first to final attempt). Values must be positive ` +
          `integers with a first-to-final window no greater than ${MAX_HEALTHCHECK_WINDOW_SECONDS}s.`,
      );
    }
    return {
      attempts: DEFAULT_HEALTHCHECK_ATTEMPTS,
      intervalSeconds: DEFAULT_HEALTHCHECK_INTERVAL_SECONDS,
      firstToFinalWindowSeconds: DEFAULT_HEALTHCHECK_WINDOW_SECONDS,
    };
  }

  return { attempts, intervalSeconds, firstToFinalWindowSeconds };
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getStateDir(env = process.env) {
  return readString(env.NORA_UPGRADE_STATE_DIR) || DEFAULT_STATE_DIR;
}

function getStatePath(env = process.env) {
  return path.join(getStateDir(env), "status.json");
}

function getLogTailLines(env = process.env) {
  return parsePositiveInteger(env.NORA_UPGRADE_LOG_TAIL_LINES, DEFAULT_LOG_TAIL_LINES);
}

function normalizeGithubRepoSlug(repoUrl) {
  const normalized = readString(repoUrl)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : "";
}

function isPublicGithubHttpsRepo(value) {
  const normalized = readString(value);
  if (!normalized) return false;

  let url;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "github.com" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    Boolean(normalizeGithubRepoSlug(normalized))
  );
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeComposeFiles(value, fallback = DEFAULT_COMPOSE_FILES) {
  const parsed = splitList(value);
  return parsed.length ? parsed : [...fallback];
}

function shellQuote(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function buildComposeCommand({ envFile, composeFiles }) {
  const args = [
    "docker compose",
    "--env-file",
    shellQuote(envFile || DEFAULT_ENV_FILE),
    ...normalizeComposeFiles(composeFiles).flatMap((file) => ["-f", shellQuote(file)]),
    "up",
    "-d",
    "--build",
  ];
  return args.join(" ");
}

async function inspectCurrentComposeMetadata() {
  if (typeof docker.getContainer !== "function") return {};

  const containerId = readString(process.env.HOSTNAME) || os.hostname();
  if (!containerId) return {};

  try {
    const container = docker.getContainer(containerId);
    if (!container || typeof container.inspect !== "function") return {};
    const details = await container.inspect();
    const labels = details?.Config?.Labels || details?.Config?.labels || {};
    const configFiles = splitList(labels["com.docker.compose.project.config_files"]);
    return {
      workingDir: readString(labels["com.docker.compose.project.working_dir"]) || "",
      configFiles,
    };
  } catch {
    return {};
  }
}

function repoMirrorPathFor(hostPath, hostRepoDir) {
  const normalizedHostPath = readString(hostPath);
  const normalizedRepoDir = readString(hostRepoDir);
  if (!normalizedHostPath) return "";
  if (!path.isAbsolute(normalizedHostPath)) {
    return path.join(HOST_REPO_MOUNT, normalizedHostPath);
  }
  if (!normalizedRepoDir || !path.isAbsolute(normalizedRepoDir)) return "";
  const relative = path.relative(normalizedRepoDir, normalizedHostPath);
  if (relative === "") return HOST_REPO_MOUNT;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return path.join(HOST_REPO_MOUNT, relative);
}

async function pathExists(filePath, type = "any") {
  if (!filePath) return false;
  try {
    const stat = await fsp.stat(filePath);
    if (type === "file") return stat.isFile();
    if (type === "directory") return stat.isDirectory();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve and validate direct-upgrade configuration from environment values and
 * Compose labels, marking it unavailable for an invalid host path or source.
 *
 * @param {Object} env - Environment-style upgrade configuration.
 * @returns {Promise<Object>} Internal runner and public capability configuration.
 */
async function resolveUpgradeConfig(env = process.env) {
  const composeMetadata = await inspectCurrentComposeMetadata();
  const autoConfig = buildAutoUpgrade(env, { includeInternal: true });
  const hostRepoDir =
    readString(env.NORA_HOST_REPO_DIR) || readString(composeMetadata.workingDir) || "";
  const envFile = readString(env.NORA_ENV_FILE) || DEFAULT_ENV_FILE;
  const envComposeFiles = normalizeComposeFiles(env.NORA_UPGRADE_COMPOSE_FILES, []);
  const labelComposeFiles = normalizeComposeFiles(composeMetadata.configFiles, []);
  const composeFiles = envComposeFiles.length
    ? envComposeFiles
    : labelComposeFiles.length
      ? labelComposeFiles
      : [...DEFAULT_COMPOSE_FILES];
  const sourceRepo = readString(env.NORA_UPGRADE_REPO) || DEFAULT_UPGRADE_REPO;
  const sourceRef = readString(env.NORA_UPGRADE_REF) || DEFAULT_UPGRADE_REF;
  const enabled = parseBooleanEnv(env.NORA_AUTO_UPGRADE_ENABLED);
  const hostRepoDirIsUsable = hostRepoDir && path.isAbsolute(hostRepoDir);
  const sourceRepoIsPublicGithubHttps = isPublicGithubHttpsRepo(sourceRepo);

  let disabledReason = null;
  if (!enabled) {
    disabledReason =
      "Auto-upgrade is disabled. Set NORA_AUTO_UPGRADE_ENABLED=true to allow direct GitHub upgrades.";
  } else if (!hostRepoDir) {
    disabledReason =
      "Direct GitHub upgrade requires NORA_HOST_REPO_DIR or Docker Compose working-dir labels.";
  } else if (!hostRepoDirIsUsable) {
    disabledReason =
      "Direct GitHub upgrade requires the Nora host repo path to be an absolute Linux path visible to Docker.";
  } else if (!sourceRepoIsPublicGithubHttps) {
    disabledReason =
      "Direct GitHub upgrade requires NORA_UPGRADE_REPO to be a public HTTPS GitHub repository URL without embedded credentials.";
  }

  return {
    ...autoConfig,
    enabled,
    available: Boolean(enabled && hostRepoDirIsUsable && sourceRepoIsPublicGithubHttps),
    disabledReason,
    hostRepoDir,
    hostRepoDirSource: readString(env.NORA_HOST_REPO_DIR)
      ? "env"
      : readString(composeMetadata.workingDir)
        ? "compose-label"
        : "missing",
    sourceRepo,
    sourceRef,
    sourceRepoIsPublicGithubHttps,
    runnerImage: readString(env.NORA_UPGRADE_RUNNER_IMAGE) || DEFAULT_RUNNER_IMAGE,
    stateVolume: readString(env.NORA_UPGRADE_STATE_VOLUME) || DEFAULT_STATE_VOLUME,
    stateDir: readString(env.NORA_UPGRADE_STATE_DIR) || DEFAULT_STATE_DIR,
    envFile,
    composeFiles,
    composeFilesSource: envComposeFiles.length
      ? "env"
      : labelComposeFiles.length
        ? "compose-label"
        : "default",
    command: buildComposeCommand({ envFile, composeFiles }),
  };
}

// ── Persisted state and public projections ──────────────────────

function buildIdleState() {
  return {
    job: null,
    updatedAt: new Date().toISOString(),
  };
}

function isRunningJob(job) {
  return RUNNING_PHASES.has(job?.phase);
}

function publicAutoUpgrade(config, override = {}) {
  return {
    enabled: Boolean(config.enabled),
    available: override.available ?? Boolean(config.available),
    mode: config.mode || "github_direct",
    sourceRepo: config.sourceRepo || DEFAULT_UPGRADE_REPO,
    sourceRef: config.sourceRef || DEFAULT_UPGRADE_REF,
    envFile: config.envFile || DEFAULT_ENV_FILE,
    composeFiles: normalizeComposeFiles(config.composeFiles),
    command: config.command || buildComposeCommand(config),
    disabledReason: override.disabledReason ?? config.disabledReason ?? null,
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    phase: job.phase,
    currentVersion: job.currentVersion || null,
    targetVersion: job.targetVersion || null,
    releaseNotesUrl: job.releaseNotesUrl || null,
    requestedBy: job.requestedBy || null,
    requestedAt: job.requestedAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    exitCode: job.exitCode ?? null,
    signal: job.signal || null,
    error: job.error || null,
    containerId: job.containerId || null,
    sourceRepo: job.sourceRepo || null,
    sourceRef: job.sourceRef || null,
    envFile: job.envFile || null,
    composeFiles: normalizeComposeFiles(job.composeFiles || []),
    command: job.command || null,
  };
}

/**
 * Best-effort redaction for known environment secrets and common credential
 * patterns. It reduces accidental disclosure but is not an exhaustive sanitizer.
 *
 * @param {string} input - Log or error text.
 * @param {Object} env - Environment containing values to redact.
 * @returns {string} Redacted text.
 */
function redactText(input, env = process.env) {
  let output = String(input || "");
  const secretValues = [
    env.JWT_SECRET,
    env.ENCRYPTION_KEY,
    env.DB_PASSWORD,
    env.NORA_UPGRADE_REPO,
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.AWS_SECRET_ACCESS_KEY,
  ]
    .map(readString)
    .filter((value) => value.length >= 8);

  for (const secret of secretValues) {
    output = output.split(secret).join("[redacted]");
  }

  return output
    .replace(/(token|secret|password|key)=([^\s]+)/gi, "$1=[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]");
}

async function ensureStateDir(env = process.env) {
  await fsp.mkdir(getStateDir(env), { recursive: true });
}

/**
 * Read persisted upgrade state, falling back to idle after missing, malformed,
 * or unreadable state; non-missing failures are logged.
 *
 * @param {Object} env - Environment selecting the state directory.
 * @returns {Promise<Object>} Persisted or synthesized idle state.
 */
async function readState(env = process.env) {
  try {
    const payload = await fsp.readFile(getStatePath(env), "utf8");
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to read release upgrade state:", error?.message || error);
    }
  }
  return buildIdleState();
}

/**
 * Overwrite the upgrade state file directly and refresh its update timestamp;
 * persistence does not use a temporary-file rename for atomic replacement.
 *
 * @param {Object} state - Complete state to persist.
 * @param {Object} env - Environment selecting the state directory.
 * @returns {Promise<Object>} Persisted state with updatedAt.
 */
async function writeState(state, env = process.env) {
  await ensureStateDir(env);
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(getStatePath(env), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

function buildLogPath(jobId, env = process.env) {
  const safeId = String(jobId || "upgrade").replace(/[^A-Za-z0-9_.-]/g, "-");
  return path.join(getStateDir(env), `${safeId}.log`);
}

async function appendLog(logFile, text, env = process.env) {
  await ensureStateDir(env);
  await fsp.appendFile(logFile, redactText(text, env));
}

async function readLogTail(logFile, env = process.env) {
  if (!logFile) return [];

  try {
    const payload = await fsp.readFile(logFile, "utf8");
    const lines = redactText(payload, env)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    return lines.slice(-getLogTailLines(env));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to read release upgrade log:", error?.message || error);
    }
    return [];
  }
}

// ── Privileged runner launch ────────────────────────────────────

async function ensureRunnerImage(image) {
  await new Promise((resolve, reject) => {
    docker.pull(image, (pullError, stream) => {
      if (pullError) {
        reject(pullError);
        return;
      }
      docker.modem.followProgress(stream, (followError) => {
        if (followError) reject(followError);
        else resolve();
      });
    });
  });
}

function buildRunnerCommand() {
  return [
    "mkdir -p /var/lib/nora-upgrade",
    'touch "${NORA_UPGRADE_LOG_FILE}"',
    "{",
    '  echo "Installing runner tools..."',
    "  apk add --no-cache bash curl git nodejs openssl docker-cli-compose",
    "  exec bash infra/run-release-upgrade.sh",
    '} >> "${NORA_UPGRADE_LOG_FILE}" 2>&1',
  ].join("\n");
}

/**
 * Pull and launch the privileged upgrade runner. The container receives the host
 * repo as a read-write bind, the Docker socket, and the durable state volume;
 * its container ID is persisted before start.
 *
 * @param {Object} job - Mutable upgrade job state.
 * @param {Object} config - Resolved runner and repository configuration.
 * @param {Object} env - Environment forwarded to runner configuration.
 * @returns {Promise<Object>} Started Docker container.
 */
async function launchRunnerContainer(job, config, env = process.env) {
  const image = config.runnerImage || DEFAULT_RUNNER_IMAGE;
  const stateVolume = config.stateVolume || DEFAULT_STATE_VOLUME;
  const sourceRepo = config.sourceRepo || DEFAULT_UPGRADE_REPO;
  const sourceRef = config.sourceRef || DEFAULT_UPGRADE_REF;
  const repoSlug = normalizeGithubRepoSlug(sourceRepo);
  const envFile = config.envFile || DEFAULT_ENV_FILE;
  const composeFiles = normalizeComposeFiles(config.composeFiles);
  const healthcheckBudget = normalizeHealthcheckBudget(env);

  await docker.createVolume({ Name: stateVolume });
  await ensureRunnerImage(image);

  const container = await docker.createContainer({
    Image: image,
    Cmd: ["sh", "-c", buildRunnerCommand()],
    Env: [
      `NORA_UPGRADE_JOB_ID=${job.id}`,
      `NORA_UPGRADE_LOG_FILE=/var/lib/nora-upgrade/${path.basename(job.logFile)}`,
      `NORA_UPGRADE_REPO=${sourceRepo}`,
      `NORA_UPGRADE_REF=${sourceRef}`,
      `NORA_UPGRADE_REPO_SLUG=${repoSlug}`,
      `NORA_UPGRADE_TARGET_VERSION=${job.targetVersion || ""}`,
      `NORA_HOST_REPO_DIR=${config.hostRepoDir}`,
      `NORA_ENV_FILE=${envFile}`,
      `NORA_UPGRADE_COMPOSE_FILES=${composeFiles.join(":")}`,
      `NORA_UPGRADE_HEALTHCHECK_ATTEMPTS=${healthcheckBudget.attempts}`,
      `NORA_UPGRADE_HEALTHCHECK_INTERVAL_SECONDS=${healthcheckBudget.intervalSeconds}`,
      `NORA_UPGRADE_PUBLIC_HEALTH_URL=${readString(env.NORA_UPGRADE_PUBLIC_HEALTH_URL)}`,
    ],
    WorkingDir: config.hostRepoDir,
    Labels: {
      "nora.role": "release-upgrade-runner",
      "nora.release_upgrade.job_id": job.id,
    },
    HostConfig: {
      AutoRemove: false,
      Binds: [
        `${config.hostRepoDir}:${config.hostRepoDir}`,
        "/var/run/docker.sock:/var/run/docker.sock",
        `${stateVolume}:/var/lib/nora-upgrade`,
      ],
    },
  });

  job.containerId = container.id;
  await writeState({ job }, env);
  await container.start();
  return container;
}

// ── Preflight and public orchestration ──────────────────────────

function buildCheck(id, label, status, message, detail = {}) {
  return { id, label, status, message, detail };
}

function firstFailedCheck(preflight) {
  return preflight?.checks?.find((check) => check.status === "fail") || null;
}

async function pingDockerSocket() {
  if (typeof docker.ping !== "function") {
    return { ok: false, message: "Docker client does not expose ping()" };
  }

  try {
    await new Promise((resolve, reject) => {
      docker.ping((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message || "Docker socket is not reachable" };
  }
}

async function validateRepoMirrorFiles(config) {
  const checks = [];
  const repoMirrorAvailable = await pathExists(HOST_REPO_MOUNT, "directory");

  if (!repoMirrorAvailable) {
    checks.push(
      buildCheck(
        "repo_mirror",
        "Host repo mirror",
        "warn",
        "Host repo is not mounted read-only into backend-api; file checks will run inside the upgrade runner.",
        { mount: HOST_REPO_MOUNT },
      ),
    );
    return checks;
  }

  const envFilePath = repoMirrorPathFor(config.envFile, config.hostRepoDir);
  checks.push(
    (await pathExists(envFilePath, "file"))
      ? buildCheck("env_file", "Deploy env file", "pass", `Found ${config.envFile}`)
      : buildCheck(
          "env_file",
          "Deploy env file",
          "fail",
          `Missing deploy env file: ${config.envFile}`,
        ),
  );

  for (const composeFile of normalizeComposeFiles(config.composeFiles)) {
    const composeFilePath = repoMirrorPathFor(composeFile, config.hostRepoDir);
    checks.push(
      (await pathExists(composeFilePath, "file"))
        ? buildCheck("compose_file", "Compose file", "pass", `Found ${composeFile}`)
        : buildCheck(
            "compose_file",
            "Compose file",
            "fail",
            `Missing compose file: ${composeFile}`,
          ),
    );
  }

  return checks;
}

/**
 * Evaluate upgrade enablement, target availability, repository configuration,
 * Docker access, and visible deployment files. A missing read-only repo mirror
 * is a warning because the runner performs the file checks again.
 *
 * @param {Object} options - Optional release/config snapshots and environment.
 * @returns {Promise<Object>} Readiness status with pass, warning, and fail checks.
 */
async function buildReleaseUpgradePreflight({
  release = null,
  config = null,
  env = process.env,
} = {}) {
  const resolvedRelease = release || (await buildReleaseInfo(env));
  const resolvedConfig = config || (await resolveUpgradeConfig(env));
  const checks = [];

  checks.push(
    resolvedConfig.enabled
      ? buildCheck("auto_upgrade_enabled", "One-click upgrade", "pass", "Enabled")
      : buildCheck(
          "auto_upgrade_enabled",
          "One-click upgrade",
          "fail",
          "Set NORA_AUTO_UPGRADE_ENABLED=true to allow direct GitHub upgrades.",
        ),
  );

  checks.push(
    resolvedRelease.updateAvailable
      ? buildCheck(
          "target_release",
          "Target release",
          "pass",
          `Upgrade target ${resolvedRelease.latestVersion || "latest release"} is available.`,
        )
      : buildCheck(
          "target_release",
          "Target release",
          "fail",
          "This Nora control plane is already on the latest announced release.",
        ),
  );

  checks.push(
    resolvedConfig.hostRepoDir && path.isAbsolute(resolvedConfig.hostRepoDir)
      ? buildCheck(
          "host_repo_dir",
          "Host repo path",
          "pass",
          `Using ${resolvedConfig.hostRepoDir}`,
          { source: resolvedConfig.hostRepoDirSource },
        )
      : buildCheck(
          "host_repo_dir",
          "Host repo path",
          "fail",
          "Direct GitHub upgrade requires NORA_HOST_REPO_DIR or Docker Compose working-dir labels.",
        ),
  );

  checks.push(
    resolvedConfig.sourceRepoIsPublicGithubHttps
      ? buildCheck("source_repo", "Source repo", "pass", resolvedConfig.sourceRepo)
      : buildCheck(
          "source_repo",
          "Source repo",
          "fail",
          "NORA_UPGRADE_REPO must be a public HTTPS GitHub repository URL without embedded credentials.",
        ),
  );

  const dockerPing = await pingDockerSocket();
  checks.push(
    dockerPing.ok
      ? buildCheck("docker_socket", "Docker socket", "pass", "Docker daemon is reachable.")
      : buildCheck(
          "docker_socket",
          "Docker socket",
          "fail",
          dockerPing.message || "Docker daemon is not reachable from backend-api.",
        ),
  );

  checks.push(...(await validateRepoMirrorFiles(resolvedConfig)));

  const ok = checks.every((check) => check.status !== "fail");
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;

  return {
    ok,
    status: ok ? (warnings ? "warning" : "ready") : "blocked",
    checkedAt: new Date().toISOString(),
    command: resolvedConfig.command,
    config: {
      hostRepoDir: resolvedConfig.hostRepoDir || null,
      hostRepoDirSource: resolvedConfig.hostRepoDirSource,
      sourceRepo: resolvedConfig.sourceRepo,
      sourceRef: resolvedConfig.sourceRef,
      envFile: resolvedConfig.envFile,
      composeFiles: normalizeComposeFiles(resolvedConfig.composeFiles),
      composeFilesSource: resolvedConfig.composeFilesSource,
    },
    summary: {
      passed: checks.filter((check) => check.status === "pass").length,
      warnings,
      failed,
    },
    checks,
  };
}

/**
 * Read the current public upgrade status, including fresh release/preflight data,
 * persisted job state, and a redacted log tail.
 *
 * @param {Object} env - Environment-style release and runner configuration.
 * @returns {Promise<Object>} Public upgrade capability and job status.
 */
async function getReleaseUpgradeStatus(env = process.env) {
  const release = await buildReleaseInfo(env);
  const config = await resolveUpgradeConfig(env);
  const preflight = await buildReleaseUpgradePreflight({ release, config, env });
  const state = await readState(env);
  const job = state.job || null;
  const failedCheck = firstFailedCheck(preflight);
  const disabledReason = failedCheck?.message || config.disabledReason || null;

  return {
    release,
    autoUpgrade: publicAutoUpgrade(config, {
      available: preflight.ok,
      disabledReason,
    }),
    runnerReachable:
      preflight.checks.find((check) => check.id === "docker_socket")?.status === "pass"
        ? true
        : preflight.checks.find((check) => check.id === "docker_socket")?.status === "fail"
          ? false
          : null,
    preflight,
    job: publicJob(job),
    logTail: await readLogTail(job?.logFile, env),
    updatedAt: state.updatedAt || null,
  };
}

/**
 * Queue and launch a direct GitHub upgrade after a fresh preflight. A persisted
 * running phase is rejected, but the read/check/write sequence is not a
 * cross-process lock; launch failures are persisted before returning HTTP 503.
 *
 * @param {Object} options - Requesting actor and environment configuration.
 * @returns {Promise<Object>} Public status for the launched upgrade.
 */
async function startReleaseUpgrade({ actor = null, env = process.env } = {}) {
  const release = await buildReleaseInfo(env);
  const config = await resolveUpgradeConfig(env);

  const currentState = await readState(env);
  if (isRunningJob(currentState.job)) {
    throw createHttpError("A release upgrade is already running", 409);
  }

  const preflight = await buildReleaseUpgradePreflight({ release, config, env });
  const failedCheck = firstFailedCheck(preflight);
  if (!preflight.ok) {
    throw createHttpError(
      failedCheck?.message || "Release upgrade preflight failed",
      failedCheck?.id === "target_release" ? 409 : 503,
    );
  }

  const now = new Date().toISOString();
  const jobId = `upgrade-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const job = {
    id: jobId,
    phase: "queued",
    currentVersion: release.currentVersion || null,
    targetVersion: release.latestVersion || null,
    releaseNotesUrl: release.releaseNotesUrl || null,
    requestedBy: actor
      ? {
          id: actor.id || null,
          email: actor.email || null,
          role: actor.role || null,
        }
      : null,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    sourceRepo: config.sourceRepo,
    sourceRef: config.sourceRef,
    envFile: config.envFile,
    composeFiles: normalizeComposeFiles(config.composeFiles),
    command: config.command,
    logFile: buildLogPath(jobId, env),
    containerId: null,
  };

  await writeState({ job }, env);
  await appendLog(job.logFile, `Queued direct GitHub upgrade job ${job.id}\n`, env);

  try {
    await launchRunnerContainer(job, config, env);
  } catch (error) {
    const failedJob = {
      ...job,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: error?.message || "Failed to start GitHub upgrade runner",
    };
    await appendLog(job.logFile, `${failedJob.error}\n`, env).catch(() => {});
    await writeState({ job: failedJob }, env);
    throw createHttpError(failedJob.error, 503);
  }

  const state = await readState(env);
  const currentJob = state.job || job;
  return {
    release,
    autoUpgrade: publicAutoUpgrade(config, { available: preflight.ok }),
    runnerReachable: true,
    preflight,
    job: publicJob(currentJob),
    logTail: await readLogTail(currentJob.logFile, env),
    updatedAt: state.updatedAt || null,
  };
}

module.exports = {
  buildReleaseUpgradePreflight,
  getReleaseUpgradeStatus,
  launchRunnerContainer,
  normalizeHealthcheckBudget,
  readState,
  redactText,
  resolveUpgradeConfig,
  startReleaseUpgrade,
  writeState,
};
