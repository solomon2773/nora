import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const infraDir = path.join(repoRoot, "infra");

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "inherit",
  });
}

function walk(dir, predicate, matches = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, predicate, matches);
      continue;
    }
    if (predicate(fullPath)) {
      matches.push(fullPath);
    }
  }
  return matches;
}

function validateComposeFiles() {
  const composeEnv = {
    NORA_ENV_FILE: ".env.test",
    NGINX_CONFIG_FILE: "nginx.public.conf",
    NGINX_HTTP_PORT: "80",
  };

  run(
    "docker",
    ["compose", "--env-file", ".env.test", "-f", "docker-compose.e2e.yml", "config", "-q"],
    {
      NORA_ENV_FILE: ".env.test",
    },
  );
  run(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.test",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/docker-compose.public-prod.yml",
      "config",
      "-q",
    ],
    composeEnv,
  );
  run(
    "docker",
    [
      "compose",
      "--env-file",
      ".env.test",
      "-f",
      "docker-compose.yml",
      "-f",
      "infra/docker-compose.public-prod.yml",
      "-f",
      "infra/docker-compose.public-tls.yml",
      "config",
      "-q",
    ],
    composeEnv,
  );
}

function validateKindConfig(filePath) {
  const parsed = parse(fs.readFileSync(filePath, "utf8"));
  if (parsed?.kind !== "Cluster") {
    throw new Error(`${path.relative(repoRoot, filePath)} must declare kind: Cluster`);
  }
  if (!String(parsed?.apiVersion || "").startsWith("kind.x-k8s.io/")) {
    throw new Error(`${path.relative(repoRoot, filePath)} must use a kind.x-k8s.io apiVersion`);
  }
  if (!Array.isArray(parsed?.nodes) || parsed.nodes.length === 0) {
    throw new Error(`${path.relative(repoRoot, filePath)} must declare at least one node`);
  }
}

function validateHelmCharts(chartFiles) {
  for (const chartFile of chartFiles) {
    const chartDir = path.dirname(chartFile);
    run("helm", ["lint", chartDir]);
  }
}

function validateKubernetesManifests(manifestFiles) {
  if (manifestFiles.length === 0) {
    console.log("No Kubernetes deployment manifests found under infra/.");
    return;
  }

  run("kubeconform", ["-summary", ...manifestFiles.map((file) => path.relative(repoRoot, file))]);
}

validateComposeFiles();

const chartFiles = walk(infraDir, (fullPath) => path.basename(fullPath) === "Chart.yaml");
const yamlFiles = walk(infraDir, (fullPath) => /\.(ya?ml)$/i.test(fullPath));
const manifestFiles = [];

for (const yamlFile of yamlFiles) {
  const relativePath = path.relative(repoRoot, yamlFile);
  if (relativePath.startsWith("infra/docker-compose.")) {
    continue;
  }

  const content = fs.readFileSync(yamlFile, "utf8");
  if (/apiVersion:\s*kind\.x-k8s\.io\//.test(content)) {
    validateKindConfig(yamlFile);
    continue;
  }

  if (/^\s*apiVersion:/m.test(content) && /^\s*kind:/m.test(content)) {
    manifestFiles.push(yamlFile);
  }
}

validateHelmCharts(chartFiles);
validateKubernetesManifests(manifestFiles);

console.log("Infrastructure validation passed.");
