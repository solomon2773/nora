// @ts-nocheck

const { buildAutoUpgrade, buildReleaseInfo, compareVersions } = require("../releaseInfo");

describe("releaseInfo helper unit tests", () => {
  describe("compareVersions (semver & fallback comparison)", () => {
    it("returns 0 for identical semver versions with or without v prefix", () => {
      expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
      expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
      expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
      expect(compareVersions("v2.0.0", "V2.0.0")).toBe(0);
    });

    it("compares major, minor, and patch differences correctly", () => {
      expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
      expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);

      expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
      expect(compareVersions("1.2.9", "1.3.0")).toBe(-1);

      expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
      expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    });

    it("handles prerelease versions according to semver 2.0.0 precedence", () => {
      // Prerelease is lower precedence than normal release
      expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.0-alpha")).toBe(1);

      // Prerelease progression
      expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
      expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
      expect(compareVersions("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1);
      expect(compareVersions("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
      expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
      expect(compareVersions("1.0.0-beta.11", "1.0.0-rc.1")).toBe(-1);
      expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    });

    it("ignores build metadata in semver comparison", () => {
      expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
      expect(compareVersions("1.0.0+20260820", "1.0.0")).toBe(0);
    });

    it("falls back to locale numeric comparison for non-semver labels", () => {
      expect(compareVersions("build-10", "build-2")).toBe(1);
      expect(compareVersions("build-2", "build-10")).toBe(-1);
      expect(compareVersions("nightly-2026-08-20", "nightly-2026-08-19")).toBe(1);
      expect(compareVersions("dev", "dev")).toBe(0);
    });

    it("handles empty or missing version inputs safely", () => {
      expect(compareVersions("", "")).toBe(0);
      expect(compareVersions(null, null)).toBe(0);
      expect(compareVersions(undefined, undefined)).toBe(0);
      expect(compareVersions("1.0.0", "")).toBe(1);
      expect(compareVersions("", "1.0.0")).toBe(-1);
    });
  });

  describe("buildAutoUpgrade (auto-upgrade eligibility descriptor)", () => {
    it("returns disabled descriptor when NORA_AUTO_UPGRADE_ENABLED is not set", () => {
      const result = buildAutoUpgrade({});
      expect(result.enabled).toBe(false);
      expect(result.available).toBe(false);
      expect(result.disabledReason).toContain("Auto-upgrade is disabled");
    });

    it("returns disabled when host repo dir is missing", () => {
      const result = buildAutoUpgrade({
        NORA_AUTO_UPGRADE_ENABLED: "true",
      });
      expect(result.enabled).toBe(true);
      expect(result.available).toBe(false);
      expect(result.disabledReason).toContain(
        "requires NORA_HOST_REPO_DIR to point at the host Nora repo checkout",
      );
    });

    it("rejects non-absolute host repo directory path", () => {
      const result = buildAutoUpgrade({
        NORA_AUTO_UPGRADE_ENABLED: "true",
        NORA_HOST_REPO_DIR: "relative/path/to/nora",
      });
      expect(result.enabled).toBe(true);
      expect(result.available).toBe(false);
      expect(result.disabledReason).toContain("to be an absolute Linux host path");
    });

    it("rejects non-public or insecure source repository URLs", () => {
      const invalidRepos = [
        "http://github.com/solomon2773/nora.git", // HTTP insecure
        "https://gitlab.com/solomon2773/nora.git", // non-GitHub
        "https://user:password@github.com/solomon2773/nora.git", // credentials in URL
        "git@github.com:solomon2773/nora.git", // SSH protocol
        "not_a_url",
      ];

      for (const repo of invalidRepos) {
        const result = buildAutoUpgrade({
          NORA_AUTO_UPGRADE_ENABLED: "true",
          NORA_HOST_REPO_DIR: "/opt/nora",
          NORA_UPGRADE_REPO: repo,
        });
        expect(result.available).toBe(false);
        expect(result.disabledReason).toContain("public HTTPS GitHub repository URL");
      }
    });

    it("returns fully available descriptor for valid configuration", () => {
      const result = buildAutoUpgrade({
        NORA_AUTO_UPGRADE_ENABLED: "true",
        NORA_HOST_REPO_DIR: "/home/nora/nora-checkout",
        NORA_UPGRADE_REPO: "https://github.com/solomon2773/nora.git",
        NORA_UPGRADE_REF: "master",
      });

      expect(result.enabled).toBe(true);
      expect(result.available).toBe(true);
      expect(result.mode).toBe("github_direct");
      expect(result.sourceRepo).toBe("https://github.com/solomon2773/nora.git");
      expect(result.sourceRef).toBe("master");
      expect(result.disabledReason).toBeNull();
      expect(result.hostRepoDir).toBeUndefined(); // internal omitted by default
    });

    it("includes internal orchestrator fields when includeInternal is set", () => {
      const result = buildAutoUpgrade(
        {
          NORA_AUTO_UPGRADE_ENABLED: "true",
          NORA_HOST_REPO_DIR: "/opt/nora",
          NORA_UPGRADE_RUNNER_IMAGE: "custom-docker:cli",
          NORA_UPGRADE_STATE_VOLUME: "custom_volume",
          NORA_UPGRADE_STATE_DIR: "/custom/state",
        },
        { includeInternal: true },
      );

      expect(result.hostRepoDir).toBe("/opt/nora");
      expect(result.runnerImage).toBe("custom-docker:cli");
      expect(result.stateVolume).toBe("custom_volume");
      expect(result.stateDir).toBe("/custom/state");
    });
  });

  describe("buildReleaseInfo (release tracking & status summary)", () => {
    it("reports updateAvailable = true when current version is behind latest release", async () => {
      const env = {
        NORA_CURRENT_VERSION: "v1.14.0",
        NORA_CURRENT_COMMIT: "abc1234",
        NORA_AUTO_UPGRADE_ENABLED: "false",
      };

      const info = await buildReleaseInfo(env);
      expect(info.currentVersion).toBe("v1.14.0");
      expect(info.currentCommit).toBe("abc1234");
      expect(info.trackingConfigured).toBe(true);
      expect(info.canAutoUpgrade).toBe(false);
      expect(info.installMethod).toBe("source");
    });

    it("supports custom manual upgrade steps and commands", async () => {
      const env = {
        NORA_MANUAL_UPGRADE_COMMAND: "git pull && docker compose up -d --build",
        NORA_MANUAL_UPGRADE_STEPS: "Step 1: pull latest\nStep 2: restart services",
      };

      const info = await buildReleaseInfo(env);
      expect(info.manualUpgrade.command).toBe("git pull && docker compose up -d --build");
      expect(info.manualUpgrade.steps).toEqual(["Step 1: pull latest", "Step 2: restart services"]);
    });
  });
});
