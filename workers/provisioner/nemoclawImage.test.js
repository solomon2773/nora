const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const Docker = require("dockerode");

const { demuxDockerExecStream } = require("./backends/dockerExecStream.ts");
const {
  ensureNemoClawImage,
  isMutableNemoClawImageReference,
} = require("./backends/nemoclawImage.ts");

test("NemoClaw image references distinguish mutable tags from immutable releases", () => {
  assert.equal(
    isMutableNemoClawImageReference("ghcr.io/solomon2773/nora-nemoclaw-agent:latest"),
    true,
  );
  assert.equal(isMutableNemoClawImageReference("ghcr.io/solomon2773/nora-nemoclaw-agent"), true);
  assert.equal(isMutableNemoClawImageReference("nora-nemoclaw-agent:local"), false);
  assert.equal(
    isMutableNemoClawImageReference("ghcr.io/solomon2773/nora-nemoclaw-agent:v1.16.3"),
    false,
  );
  assert.equal(
    isMutableNemoClawImageReference("ghcr.io/solomon2773/nora-nemoclaw-agent:latest@sha256:abc123"),
    false,
  );
});

test("NemoClaw refreshes a cached mutable image once per adapter", async () => {
  let inspectCalls = 0;
  let pullCalls = 0;
  const state = { pending: null, refreshed: false };
  const docker = {
    getImage: () => ({
      inspect: async () => {
        inspectCalls += 1;
        return { Id: "cached-image" };
      },
    }),
    pull: (_image, callback) => {
      pullCalls += 1;
      callback(null, {});
    },
    modem: {
      followProgress: (_stream, callback) => callback(null),
    },
  };

  const ensure = () =>
    ensureNemoClawImage({
      docker,
      image: "ghcr.io/solomon2773/nora-nemoclaw-agent:latest",
      state,
    });
  await Promise.all([ensure(), ensure()]);
  await ensure();

  assert.equal(inspectCalls, 2);
  assert.equal(pullCalls, 1);
});

test("NemoClaw retries a failed mutable image refresh", async () => {
  let pullCalls = 0;
  const state = { pending: null, refreshed: false };
  const docker = {
    getImage: () => ({ inspect: async () => ({ Id: "cached-image" }) }),
    pull: (_image, callback) => {
      pullCalls += 1;
      if (pullCalls === 1) return callback(new Error("registry unavailable"));
      callback(null, {});
    },
    modem: {
      followProgress: (_stream, callback) => callback(null),
    },
  };

  const ensure = () =>
    ensureNemoClawImage({
      docker,
      image: "ghcr.io/solomon2773/nora-nemoclaw-agent:latest",
      state,
    });
  await assert.rejects(ensure(), /registry unavailable/);
  await ensure();

  assert.equal(pullCalls, 2);
});

test("NemoClaw demuxes non-TTY Docker exec output", async () => {
  const rawStream = new PassThrough();
  const payload = Buffer.from(`${'{"status":"ok"}'.padEnd(67, " ")}\n`);
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = 1;
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 8);
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });
  const stream = demuxDockerExecStream(docker, rawStream);
  setImmediate(() => rawStream.end(frame));
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  assert.equal(Buffer.concat(chunks).toString("utf8"), payload.toString("utf8"));
});
