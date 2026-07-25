// @ts-nocheck
// Regression coverage for the production-only backend module-resolution bug:
// in the worker-provisioner prod image, containerManager runs from /backend-api
// while the worker's real adapters live at /app/backends and there is no
// /workers directory. The resolver must find the real adapter at /app/backends
// instead of returning the re-export shim (whose ../../workers/... path is dead
// there) or the dead /workers fallback. See resolveBackendPath in containerManager.

const { resolveBackendPath, backendPathCandidates } = require("../containerManager");

// Build a fake require.resolve that "resolves" only the paths present in the
// given set and throws MODULE_NOT_FOUND for everything else, mirroring a
// specific on-disk container layout.
function fakeResolver(existingPaths) {
  const set = new Set(existingPaths);
  return (p) => {
    if (set.has(p)) return p;
    const err = new Error(`Cannot find module '${p}'`);
    err.code = "MODULE_NOT_FOUND";
    throw err;
  };
}

describe("backendPathCandidates", () => {
  it("tries the canonical /app/backends location first", () => {
    const candidates = backendPathCandidates("hermes", {
      appBackendsDir: "/app/backends",
      dirname: "/backend-api",
    });
    expect(candidates[0]).toBe("/app/backends/hermes");
    // The dead worker-relative path must not be the only fallback.
    expect(candidates).toContain("/backend-api/backends/hermes");
  });
});

describe("resolveBackendPath — worker-provisioner prod image layout", () => {
  // Worker image: containerManager at /backend-api, real adapters at /app/backends,
  // the re-export shim present at /backend-api/backends/{hermes,nemoclaw}, no /workers.
  const dirname = "/backend-api";
  const appBackendsDir = "/app/backends";

  it("resolves a shimmed backend (hermes) to the real /app/backends adapter, not the shim", () => {
    const resolve = fakeResolver([
      "/app/backends/hermes", // real worker adapter (COPY workers/provisioner/ -> /app)
      "/backend-api/backends/hermes", // the re-export shim (its ../../workers path is dead)
    ]);
    expect(resolveBackendPath("hermes", { resolve, dirname, appBackendsDir })).toBe(
      "/app/backends/hermes",
    );
  });

  it("resolves a shimmed backend (nemoclaw) to the real /app/backends adapter", () => {
    const resolve = fakeResolver(["/app/backends/nemoclaw", "/backend-api/backends/nemoclaw"]);
    expect(resolveBackendPath("nemoclaw", { resolve, dirname, appBackendsDir })).toBe(
      "/app/backends/nemoclaw",
    );
  });

  it("resolves a non-shim backend (docker) to /app/backends when no /workers dir exists", () => {
    // Only the real adapter exists; /backend-api/backends/docker and
    // /workers/provisioner/backends/docker are both absent in this image.
    const resolve = fakeResolver(["/app/backends/docker"]);
    expect(resolveBackendPath("docker", { resolve, dirname, appBackendsDir })).toBe(
      "/app/backends/docker",
    );
  });
});

describe("resolveBackendPath — backend-api image + dev layouts (no regression)", () => {
  it("resolves to /app/backends when containerManager runs from /app", () => {
    const resolve = fakeResolver(["/app/backends/hermes"]);
    expect(
      resolveBackendPath("hermes", { resolve, dirname: "/app", appBackendsDir: "/app/backends" }),
    ).toBe("/app/backends/hermes");
  });

  it("falls back to the dev sibling path when /app/backends is absent", () => {
    // Local dev / running tests off a checkout: no /app dir; the worker-sibling
    // copy is what exists.
    const resolve = fakeResolver(["/repo/workers/provisioner/backends/docker"]);
    expect(
      resolveBackendPath("docker", {
        resolve,
        dirname: "/repo/backend-api",
        appBackendsDir: "/app/backends",
      }),
    ).toBe("/repo/workers/provisioner/backends/docker");
  });

  it("returns the dev-sibling path as a last resort so failures name a real path", () => {
    const resolve = fakeResolver([]); // nothing resolves
    expect(
      resolveBackendPath("docker", {
        resolve,
        dirname: "/repo/backend-api",
        appBackendsDir: "/app/backends",
      }),
    ).toBe("/repo/workers/provisioner/backends/docker");
  });
});
