import { describe, expect, it } from "vitest";

import * as containerCommand from "../lib/containerCommand.ts";

const { DEFAULT_SHELL, buildContainerBootstrap, shellSingleQuote, toDockerLaunch, toK8sLaunch } =
  containerCommand;

describe("container bootstrap helpers", () => {
  it("builds a deterministic default shell command", () => {
    const bootstrap = buildContainerBootstrap("echo hello");

    expect(bootstrap).toEqual({
      interpreter: [DEFAULT_SHELL, "-c"],
      script: "echo hello",
    });
  });

  it("uses login shell mode when requested", () => {
    expect(buildContainerBootstrap("echo hello", { login: true })).toEqual({
      interpreter: [DEFAULT_SHELL, "-lc"],
      script: "echo hello",
    });
  });

  it("adapts the bootstrap shape for Docker and Kubernetes", () => {
    const bootstrap = buildContainerBootstrap("printf ready", { shell: "/bin/bash" });

    expect(toDockerLaunch(bootstrap)).toEqual({
      Entrypoint: ["/bin/bash", "-c"],
      Cmd: ["printf ready"],
    });
    expect(toK8sLaunch(bootstrap)).toEqual({
      command: ["/bin/bash", "-c"],
      args: ["printf ready"],
    });
  });

  it("single-quotes arbitrary shell input safely", () => {
    expect(shellSingleQuote("plain")).toBe("'plain'");
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
    expect(shellSingleQuote("$(curl https://example.com)")).toBe("'$(curl https://example.com)'");
  });
});
