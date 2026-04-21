// Contract tests for the shared container-launch helper that every
// provisioner backend routes through. The helper's job is to produce a
// deterministic (Entrypoint, Cmd) / (command, args) pair that does NOT
// depend on the base image's ENTRYPOINT being empty — see
// agent-runtime/lib/containerCommand.ts.
//
// If any of these assertions change, also update:
//   - workers/provisioner/backends/docker.ts
//   - workers/provisioner/backends/nemoclaw.ts
//   - workers/provisioner/backends/k8s.ts
//   - workers/provisioner/backends/hermes.ts

const {
  buildContainerBootstrap,
  toDockerLaunch,
  toK8sLaunch,
  DEFAULT_SHELL,
} = require("../../agent-runtime/lib/containerCommand");

describe("buildContainerBootstrap", () => {
  test("defaults to /bin/sh -c with a single script arg", () => {
    const b = buildContainerBootstrap("echo hi");
    expect(b.interpreter).toEqual(["/bin/sh", "-c"]);
    expect(b.script).toBe("echo hi");
  });

  test("DEFAULT_SHELL is /bin/sh (POSIX-universal)", () => {
    expect(DEFAULT_SHELL).toBe("/bin/sh");
  });

  test("explicit shell override is honoured", () => {
    const b = buildContainerBootstrap("echo hi", { shell: "/bin/bash" });
    expect(b.interpreter).toEqual(["/bin/bash", "-c"]);
  });

  test("login=true selects -lc so /etc/profile gets sourced", () => {
    const b = buildContainerBootstrap("echo hi", {
      shell: "/bin/bash",
      login: true,
    });
    expect(b.interpreter).toEqual(["/bin/bash", "-lc"]);
  });

  test("coerces non-string scripts to empty string rather than 'undefined'", () => {
    expect(buildContainerBootstrap(null).script).toBe("");
    expect(buildContainerBootstrap(undefined).script).toBe("");
  });

  test("empty-string shell falls back to default", () => {
    const b = buildContainerBootstrap("x", { shell: "" });
    expect(b.interpreter).toEqual(["/bin/sh", "-c"]);
  });
});

describe("toDockerLaunch", () => {
  test("produces Entrypoint + single-item Cmd (dockerode shape)", () => {
    const launch = toDockerLaunch(buildContainerBootstrap("echo hi"));
    expect(launch).toEqual({
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["echo hi"],
    });
  });

  test("preserves the script verbatim — no word-splitting", () => {
    const script = "echo 'hello world' && exec foo $BAR \"baz qux\"";
    const launch = toDockerLaunch(buildContainerBootstrap(script));
    expect(launch.Cmd).toEqual([script]);
  });
});

describe("toK8sLaunch", () => {
  test("produces command + args (PodSpec shape)", () => {
    const launch = toK8sLaunch(buildContainerBootstrap("echo hi"));
    expect(launch).toEqual({
      command: ["/bin/sh", "-c"],
      args: ["echo hi"],
    });
  });

  test("k8s command overrides image ENTRYPOINT, args overrides CMD", () => {
    // This is the reason we split interpreter vs script — Kubernetes requires
    // it, and Docker happens to accept the same split identically.
    const launch = toK8sLaunch(buildContainerBootstrap("foo", { shell: "/bin/bash", login: true }));
    expect(launch.command).toEqual(["/bin/bash", "-lc"]);
    expect(launch.args).toEqual(["foo"]);
  });
});

describe("regression — the NemoClaw ENTRYPOINT bug", () => {
  // The NemoClaw sandbox image ships with ENTRYPOINT ["/bin/bash"]. Before
  // this helper existed, the backend set only Cmd: ["sh","-c",<script>] and
  // Docker combined them into `/bin/bash sh -c <script>`, which made bash
  // treat `sh` as a shell-script filename → "cannot execute binary file".
  //
  // The fix below must produce a launch spec whose Entrypoint fully replaces
  // the image's /bin/bash, not appends to it.
  test("Entrypoint is an absolute interpreter — never relies on the image's ENTRYPOINT", () => {
    const launch = toDockerLaunch(buildContainerBootstrap("bootstrap"));
    expect(launch.Entrypoint[0].startsWith("/")).toBe(true);
    expect(launch.Entrypoint.length).toBeGreaterThanOrEqual(2);
    expect(launch.Cmd.length).toBe(1);
  });
});
