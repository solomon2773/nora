// Tests for infra/ensure-log-env.sh and its use from infra/update-release-env.sh.
//
// Run with: node --test infra/ensure-log-env.test.mjs
//
// These run the real shell scripts against throwaway env files. The scripts
// are what one-click upgrades and `setup.sh --update` execute on an operator's
// live .env, so the properties that matter are about what they must NOT do:
// replace an existing key, turn log collection on, or revert DOCKER_GID.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENSURE = path.join(here, "ensure-log-env.sh");
const UPDATE = path.join(here, "update-release-env.sh");
const GIB = 1024 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const BASE_ENV = ["JWT_SECRET=abc", "DB_PASSWORD=xyz", "NGINX_HTTP_PORT=8080", ""].join("\n");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nora-ensure-log-env-"));
}

function writeEnv(dir, extra = [], name = ".env") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, BASE_ENV + extra.join("\n") + (extra.length ? "\n" : ""));
  return file;
}

function value(file, key) {
  const line = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .pop();
  return line === undefined ? undefined : line.slice(key.length + 1);
}

function count(file, key) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`)).length;
}

function run(script, args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

/** A `df` that reports a fixed amount of free space, to exercise the low-disk path. */
function fakeBin(dir, files) {
  const bin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  return bin;
}

test("fresh pre-logging env: generates keys and a safe cap, never enables collection", () => {
  const dir = tmpDir();
  const file = writeEnv(dir);
  const result = run(ENSURE, [file]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(value(file, "NORA_LOG_ENCRYPTION_KEY"), HEX64);
  assert.match(value(file, "NORA_OTLP_INGEST_SECRET"), HEX64);
  assert.equal(value(file, "NORA_LOG_RETENTION_CEILING_DAYS"), "30");

  const cap = Number(value(file, "NORA_LOG_LOCAL_MAX_BYTES"));
  assert.ok(cap >= GIB && cap <= 10 * GIB, `cap ${cap} outside [1 GiB, 10 GiB]`);

  // The point of the opt-in default: an upgrade must not turn collection on.
  assert.equal(value(file, "NORA_LOG_ENABLED"), undefined);
  assert.match(result.stdout, /Log collection is OFF/);

  assert.equal(value(file, "JWT_SECRET"), "abc");
  assert.equal(value(file, "NGINX_HTTP_PORT"), "8080");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("a second run changes nothing", () => {
  const dir = tmpDir();
  const file = writeEnv(dir);
  run(ENSURE, [file]);
  const before = fs.readFileSync(file, "utf8");

  const second = run(ENSURE, [file]);

  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("never replaces an existing encryption key or key ring", () => {
  const dir = tmpDir();
  const ring = `k2:${"a".repeat(64)},k1:${"b".repeat(64)}`;
  const file = writeEnv(dir, [`NORA_LOG_ENCRYPTION_KEY=${ring}`]);

  run(ENSURE, [file]);

  assert.equal(value(file, "NORA_LOG_ENCRYPTION_KEY"), ring);
});

test("keeps an existing disk cap", () => {
  const dir = tmpDir();
  const file = writeEnv(dir, ["NORA_LOG_LOCAL_MAX_BYTES=123456789"]);

  run(ENSURE, [file]);

  assert.equal(value(file, "NORA_LOG_LOCAL_MAX_BYTES"), "123456789");
});

test("fills empty template lines in place without duplicating keys", () => {
  const dir = tmpDir();
  const file = writeEnv(dir, ["NORA_LOG_ENCRYPTION_KEY=", "NORA_OTLP_INGEST_SECRET="]);

  run(ENSURE, [file]);

  assert.equal(count(file, "NORA_LOG_ENCRYPTION_KEY"), 1);
  assert.equal(count(file, "NORA_OTLP_INGEST_SECRET"), 1);
  assert.match(value(file, "NORA_LOG_ENCRYPTION_KEY"), HEX64);
  assert.match(value(file, "NORA_OTLP_INGEST_SECRET"), HEX64);
});

test("respects an explicit NORA_LOG_ENABLED choice and stays quiet about it", () => {
  for (const choice of ["true", "false", '"false"']) {
    const dir = tmpDir();
    const file = writeEnv(dir, [`NORA_LOG_ENABLED=${choice}`]);

    const result = run(ENSURE, [file]);

    assert.equal(value(file, "NORA_LOG_ENABLED"), choice);
    assert.equal(count(file, "NORA_LOG_ENABLED"), 1);
    assert.doesNotMatch(result.stdout, /Log collection is OFF/);
  }
});

test("under 5 GiB free: still leaves collection undecided, with a 1 GiB cap", () => {
  const dir = tmpDir();
  const bin = fakeBin(dir, {
    df: 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/x 4000000 1 2097152 1%% /\\n"',
  });
  const file = writeEnv(dir);

  const result = run(ENSURE, [file], { PATH: `${bin}:${process.env.PATH}` });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(value(file, "NORA_LOG_LOCAL_MAX_BYTES"), String(GIB));
  assert.equal(value(file, "NORA_LOG_ENABLED"), undefined);
});

test("works when the env file path contains spaces", () => {
  const dir = path.join(tmpDir(), "dir with space");
  fs.mkdirSync(dir);
  const file = writeEnv(dir);

  const result = run(ENSURE, [file]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(value(file, "NORA_LOG_ENCRYPTION_KEY"), HEX64);
});

test("rejects a missing env file and prints a numeric recommendation", () => {
  assert.notEqual(run(ENSURE, [path.join(tmpDir(), "missing.env")]).status, 0);

  const recommend = run(ENSURE, ["--recommend-bytes", "."]);
  assert.equal(recommend.status, 0, recommend.stderr);
  assert.match(recommend.stdout.trim(), /^[0-9]+$/);
});

// update-release-env.sh is what one-click upgrades run. It needs a real unix
// socket at NORA_DOCKER_SOCKET_PATH, so listen on one.
function withSocket(dir, fn) {
  const socketPath = path.join(dir, "docker.sock");
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, async () => {
      try {
        resolve(await fn(socketPath));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

// update-release-env.sh generates this with openssl when it is missing, which
// is unrelated to what these tests check, so provide it.
const AGENT_HUB_SECRET = "NORA_AGENT_HUB_API_KEY_HASH_SECRET=existing-secret";

test("update-release-env.sh adds log settings but never enables collection", async () => {
  const dir = tmpDir();
  const file = writeEnv(dir, [AGENT_HUB_SECRET]);

  await withSocket(dir, async (socketPath) => {
    const result = run(UPDATE, [file, "v9.9.9", "deadbeef"], {
      NORA_DOCKER_SOCKET_PATH: socketPath,
    });
    assert.equal(result.status, 0, result.stderr);
  });

  assert.match(value(file, "NORA_LOG_ENCRYPTION_KEY"), HEX64);
  assert.equal(value(file, "NORA_LOG_RETENTION_CEILING_DAYS"), "30");
  assert.equal(value(file, "NORA_LOG_ENABLED"), undefined);
  assert.equal(value(file, "NORA_CURRENT_VERSION"), "v9.9.9");
});

test("update-release-env.sh writes DOCKER_GID 0 on macOS and the socket's gid elsewhere", async () => {
  const dir = tmpDir();

  await withSocket(dir, async (socketPath) => {
    // On Docker Desktop for Mac the host-side gid of the socket symlink is
    // meaningless to containers; the socket is root:root (0) inside the VM.
    const mac = writeEnv(dir, ["DOCKER_GID=1", AGENT_HUB_SECRET], "mac.env");
    const macBin = fakeBin(path.join(dir, "mac"), { uname: "echo Darwin" });
    const macRun = run(UPDATE, [mac, "v9.9.9", "deadbeef"], {
      NORA_DOCKER_SOCKET_PATH: socketPath,
      PATH: `${macBin}:${process.env.PATH}`,
    });
    assert.equal(macRun.status, 0, macRun.stderr);
    assert.equal(value(mac, "DOCKER_GID"), "0");

    const linux = writeEnv(dir, ["DOCKER_GID=1", AGENT_HUB_SECRET], "linux.env");
    const linuxBin = fakeBin(path.join(dir, "linux"), { uname: "echo Linux" });
    const linuxRun = run(UPDATE, [linux, "v9.9.9", "deadbeef"], {
      NORA_DOCKER_SOCKET_PATH: socketPath,
      PATH: `${linuxBin}:${process.env.PATH}`,
    });
    assert.equal(linuxRun.status, 0, linuxRun.stderr);
    assert.equal(value(linux, "DOCKER_GID"), String(fs.statSync(socketPath).gid));
  });
});
