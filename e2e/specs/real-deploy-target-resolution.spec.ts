import { expect, test } from "@playwright/test";
import { selectAccessibleRemoteExecutionTarget } from "./support/agents";

test.describe("Real deploy target resolution", () => {
  test("accepts only the exact deployable Remote Docker target and returns minimal metadata", () => {
    const target = selectAccessibleRemoteExecutionTarget(
      [
        {
          id: "real-smoke",
          executionTargetId: "remote:real-smoke",
          enabled: true,
          configured: true,
          connected: true,
          available: true,
          canDeploy: true,
          sshHost: "must-not-leak.example",
          sshUser: "operator",
        },
      ],
      "remote:real-smoke",
    );

    expect(target).toEqual({
      id: "remote:real-smoke",
      available: true,
      configured: true,
    });
  });

  test("rejects inaccessible, untested, unavailable, or mismatched hosts", () => {
    const readyHost = {
      id: "real-smoke",
      executionTargetId: "remote:real-smoke",
      enabled: true,
      configured: true,
      connected: true,
      available: true,
      canDeploy: true,
    };

    for (const override of [
      { enabled: false },
      { configured: false },
      { connected: false },
      { available: false },
      { canDeploy: false },
    ]) {
      expect(
        selectAccessibleRemoteExecutionTarget([{ ...readyHost, ...override }], "remote:real-smoke"),
      ).toBeNull();
    }

    expect(selectAccessibleRemoteExecutionTarget([readyHost], "remote:another-host")).toBeNull();
    expect(selectAccessibleRemoteExecutionTarget([readyHost], "REMOTE:REAL-SMOKE")).toBeNull();
    expect(selectAccessibleRemoteExecutionTarget([readyHost], "real-smoke")).toBeNull();
  });
});
