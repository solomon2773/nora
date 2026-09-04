// @ts-nocheck

const HERMES_MODEL_CONFIG_ENV = "NORA_HERMES_MODEL_CONFIG_B64";
const HERMES_MANAGED_ENV_ENV = "NORA_HERMES_MANAGED_ENV_B64";
const HERMES_EMPTY_STATE_SENTINEL = "__NORA_EMPTY_STATE_V1__";

function normalizeEnvValueMap(envVars = {}) {
  return Object.fromEntries(
    Object.entries(envVars || {})
      .filter(([key, value]) => key && value != null && String(value) !== "")
      .map(([key, value]) => [String(key), String(value)]),
  );
}

function escapeDotenvValue(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"')}"`;
}

function hasMeaningfulHermesModelConfig(modelConfig = {}) {
  return Boolean(
    String(modelConfig?.defaultModel || "").trim() ||
    String(modelConfig?.provider || "").trim() ||
    String(modelConfig?.baseUrl || "").trim(),
  );
}

function encodeBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function buildHermesManagedEnvBlock(envVars = {}) {
  return Object.entries(normalizeEnvValueMap(envVars))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${escapeDotenvValue(value)}`)
    .join("\n");
}

function buildHermesRuntimeBootstrapEnv(options = {}) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(options || {}, "envVars")) {
    const managedEnvBlock = buildHermesManagedEnvBlock(options?.envVars || {});
    out[HERMES_MANAGED_ENV_ENV] = managedEnvBlock
      ? encodeBase64(managedEnvBlock)
      : HERMES_EMPTY_STATE_SENTINEL;
  }
  if (
    Object.prototype.hasOwnProperty.call(options || {}, "modelConfig") &&
    options?.modelConfig !== undefined
  ) {
    out[HERMES_MODEL_CONFIG_ENV] = hasMeaningfulHermesModelConfig(options.modelConfig)
      ? encodeBase64(JSON.stringify(options.modelConfig || {}))
      : HERMES_EMPTY_STATE_SENTINEL;
  }
  return out;
}

function buildHermesRuntimeConfigBootstrapCommand() {
  return [
    'HERMES_DATA_DIR="${HERMES_HOME:-/opt/data}"',
    'mkdir -p "$HERMES_DATA_DIR"',
    `if [ "\${${HERMES_MANAGED_ENV_ENV}+x}" = x ]; then`,
    '  start_marker="# >>> NORA MANAGED ENV >>>"',
    '  end_marker="# <<< NORA MANAGED ENV <<<"',
    '  tmp_file="$(mktemp)"',
    '  if [ -f "$HERMES_DATA_DIR/.env" ]; then',
    '    awk -v start="$start_marker" -v end="$end_marker" \'BEGIN{skip=0} $0==start {skip=1; next} $0==end {skip=0; next} !skip {print}\' "$HERMES_DATA_DIR/.env" > "$tmp_file"',
    "  else",
    '    : > "$tmp_file"',
    "  fi",
    `  if [ "$${HERMES_MANAGED_ENV_ENV}" != ${JSON.stringify(HERMES_EMPTY_STATE_SENTINEL)} ]; then`,
    '    if [ -s "$tmp_file" ]; then printf \'\\n\' >> "$tmp_file"; fi',
    '    printf \'%s\\n\' "$start_marker" >> "$tmp_file"',
    `    printf '%s' "$${HERMES_MANAGED_ENV_ENV}" | base64 -d >> "$tmp_file"`,
    "    printf '\\n' >> \"$tmp_file\"",
    '    printf \'%s\\n\' "$end_marker" >> "$tmp_file"',
    "  fi",
    '  chown hermes:hermes "$tmp_file" 2>/dev/null || true',
    '  chmod 0600 "$tmp_file"',
    '  mv "$tmp_file" "$HERMES_DATA_DIR/.env"',
    '  chown hermes:hermes "$HERMES_DATA_DIR/.env" 2>/dev/null || true',
    '  chmod 0600 "$HERMES_DATA_DIR/.env"',
    "fi",
    // Reconcile the gateway key with the container environment (#340).
    //
    // Nora hands the runtime its API_SERVER_KEY as a container env var, but the
    // Hermes image's docker/stage2-hook.sh generates its own key into
    // $HERMES_HOME/.env whenever it does not already find one there. It checks
    // only the file, never the environment, so it treats Nora's key as absent
    // and writes a competing one. The gateway loads .env at startup and that
    // value wins, so every control-plane call into the runtime 401s with
    // "Invalid gateway API key (API_SERVER_KEY)".
    //
    // $HERMES_HOME is a persistent volume, so the mismatch survives restarts
    // and redeploys — which is why even freshly deployed agents were broken.
    // Writing our key here fixes both directions: an existing competing value
    // is replaced, and a fresh agent gets the key seeded before first start so
    // the hook's own guard sees it and skips generation. This runs before
    // `hermes gateway run` in every backend that starts Hermes, so the gateway
    // always loads the reconciled file.
    'if [ -n "${API_SERVER_KEY:-}" ]; then',
    '  key_tmp="$(mktemp)"',
    '  if [ -f "$HERMES_DATA_DIR/.env" ]; then',
    // grep -v exits 1 when every line matches; that must not abort under `set -e`.
    '    grep -v \'^API_SERVER_KEY=\' "$HERMES_DATA_DIR/.env" > "$key_tmp" || true',
    "  else",
    '    : > "$key_tmp"',
    "  fi",
    `  printf 'API_SERVER_KEY=%s\\n' "$API_SERVER_KEY" >> "$key_tmp"`,
    '  chown hermes:hermes "$key_tmp" 2>/dev/null || true',
    '  chmod 0600 "$key_tmp"',
    '  mv "$key_tmp" "$HERMES_DATA_DIR/.env"',
    '  chown hermes:hermes "$HERMES_DATA_DIR/.env" 2>/dev/null || true',
    '  chmod 0600 "$HERMES_DATA_DIR/.env"',
    "fi",
    `if [ "\${${HERMES_MODEL_CONFIG_ENV}+x}" = x ]; then`,
    '  HERMES_ROOT="/opt/hermes"',
    '  HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python"',
    '  if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$HERMES_ROOT/.venv/bin/python3"; fi',
    '  if [ ! -x "$HERMES_PYTHON" ]; then HERMES_PYTHON="$(command -v python3 2>/dev/null || true)"; fi',
    '  [ -n "$HERMES_PYTHON" ] || exit 127',
    '  if [ -d "$HERMES_ROOT" ]; then cd "$HERMES_ROOT"; fi',
    '  PYTHONPATH="$HERMES_ROOT${PYTHONPATH:+:$PYTHONPATH}" "$HERMES_PYTHON" - <<\'PY\'',
    "import base64",
    "import grp",
    "import json",
    "import os",
    "import pwd",
    "from pathlib import Path",
    "",
    "from hermes_cli.config import get_config_path, load_config, save_config",
    "",
    "def repair_surrogates(value):",
    "    if isinstance(value, str):",
    '        return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")',
    "    if isinstance(value, list):",
    "        return [repair_surrogates(item) for item in value]",
    "    if isinstance(value, dict):",
    "        return {",
    "            repair_surrogates(key) if isinstance(key, str) else key: repair_surrogates(item)",
    "            for key, item in value.items()",
    "        }",
    "    return value",
    "",
    `payload_raw = os.environ.get("${HERMES_MODEL_CONFIG_ENV}", "")`,
    `clear_model = payload_raw in ("", ${JSON.stringify(HERMES_EMPTY_STATE_SENTINEL)})`,
    'payload = {} if clear_model else json.loads(base64.b64decode(payload_raw).decode("utf-8"))',
    "config = repair_surrogates(load_config() or {})",
    'current_model = config.get("model")',
    "model = {} if clear_model else (dict(current_model) if isinstance(current_model, dict) else {})",
    "",
    'default_model = str(payload.get("defaultModel") or "").strip()',
    'provider = str(payload.get("provider") or "").strip()',
    'base_url = str(payload.get("baseUrl") or "").strip()',
    'api_key_present = "apiKey" in payload or "api_key" in payload',
    'api_key = str(payload.get("apiKey") or payload.get("api_key") or "").strip()',
    "",
    "if not clear_model:",
    "    if default_model:",
    '        model["default"] = default_model',
    "    else:",
    '        model.pop("default", None)',
    "",
    "    if provider:",
    '        model["provider"] = provider',
    "    else:",
    '        model.pop("provider", None)',
    "",
    "    if base_url:",
    '        model["base_url"] = base_url',
    "    else:",
    '        model.pop("base_url", None)',
    "",
    "    if api_key_present:",
    "        if api_key:",
    '            model["api_key"] = api_key',
    "        else:",
    '            model.pop("api_key", None)',
    '    elif provider and provider != "custom":',
    '        model.pop("api_key", None)',
    "",
    "if model:",
    '    config["model"] = model',
    "else:",
    '    config.pop("model", None)',
    "",
    "config_path = Path(get_config_path())",
    "save_config(config)",
    "try:",
    '    user = pwd.getpwnam("hermes")',
    '    group = grp.getgrnam("hermes")',
    "    os.chown(config_path, user.pw_uid, group.gr_gid)",
    "except Exception:",
    "    pass",
    "try:",
    "    config_path.chmod(0o600)",
    "except Exception:",
    "    pass",
    'print(json.dumps({"ok": True}))',
    "PY",
    "fi",
  ].join("\n");
}

module.exports = {
  HERMES_EMPTY_STATE_SENTINEL,
  HERMES_MANAGED_ENV_ENV,
  HERMES_MODEL_CONFIG_ENV,
  buildHermesManagedEnvBlock,
  buildHermesRuntimeBootstrapEnv,
  buildHermesRuntimeConfigBootstrapCommand,
};
