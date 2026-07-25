import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  clearDeployDraft,
  DEPLOY_DRAFT_STORAGE_KEY,
  loadDeployDraft,
  saveDeployDraft,
  type DeployDraft,
} from "./clawhubDeploy";

function createDraft(overrides: Partial<DeployDraft> = {}): DeployDraft {
  return {
    name: "Migrated agent",
    containerName: "",
    runtimeFamily: "openclaw",
    deployTarget: "docker",
    sandboxProfile: "standard",
    model: "",
    deploymentMode: "migrate",
    migrationMethod: "upload",
    migrationDraft: null,
    migrationSource: {},
    vcpu: 1,
    ramMb: 1024,
    diskGb: 10,
    clawhubSkills: [],
    ...overrides,
  };
}

afterEach(() => {
  clearDeployDraft();
});

function installSessionStorage(initialValue?: string) {
  const values = new Map<string, string>();
  if (initialValue !== undefined) {
    values.set(DEPLOY_DRAFT_STORAGE_KEY, initialValue);
  }

  const sessionStorage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };

  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { sessionStorage };

  return {
    readDraft() {
      return JSON.parse(values.get(DEPLOY_DRAFT_STORAGE_KEY) || "null");
    },
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = previousWindow;
      }
    },
  };
}

test("saveDeployDraft strips legacy SSH credentials and fails live migration back to upload", () => {
  const storage = installSessionStorage();

  try {
    saveDeployDraft(
      createDraft({
        migrationMethod: "live",
        migrationDraft: {
          id: "ssh-draft",
          source: { kind: "ssh", transport: "ssh", label: "root@source.example.com" },
        },
        migrationSource: {
          name: "Legacy source",
          transport: "ssh",
          host: "source.example.com",
          username: "root",
          port: "22",
          privateKey: "PRIVATE KEY",
          private_key: "PRIVATE KEY",
          password: "password",
          passphrase: "passphrase",
          password_value: "password",
          pass_phrase: "passphrase",
          container: "local-container",
          workspaceRoot: "/workspace",
        },
      }),
    );

    const stored = storage.readDraft();
    assert.equal(stored.migrationMethod, "upload");
    assert.equal(stored.migrationDraft, null);
    assert.deepEqual(stored.migrationSource, {
      name: "Legacy source",
      transport: "docker",
      container: "local-container",
      workspaceRoot: "/workspace",
      agentRoot: "",
      sessionRoot: "",
    });
    assert.doesNotMatch(JSON.stringify(stored), /PRIVATE KEY|password|passphrase/);
  } finally {
    storage.restore();
  }
});

test("deploy draft helpers remain usable when sessionStorage access is blocked", () => {
  const previousWindow = (globalThis as any).window;
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, "sessionStorage", {
    get() {
      throw new Error("storage access blocked");
    },
  });
  (globalThis as any).window = blockedWindow;

  try {
    assert.equal(loadDeployDraft(), null);
    const draft = createDraft({ name: "In-memory deploy" });
    assert.doesNotThrow(() => saveDeployDraft(draft));
    const loaded = loadDeployDraft();
    assert.equal(loaded?.name, draft.name);
    assert.deepEqual(loaded?.migrationSource, {
      name: "",
      transport: "docker",
      container: "",
      workspaceRoot: "",
      agentRoot: "",
      sessionRoot: "",
    });
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = previousWindow;
    }
  }
});

test("saveDeployDraft falls back to memory when sessionStorage writes fail", () => {
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota exceeded");
      },
      removeItem() {},
    },
  };

  try {
    const draft = createDraft({ name: "Quota fallback" });
    saveDeployDraft(draft);
    assert.equal(loadDeployDraft()?.name, draft.name);
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = previousWindow;
    }
  }
});

test("loadDeployDraft rewrites a stale secret-bearing draft in sessionStorage", () => {
  const staleDraft = createDraft({
    migrationMethod: "live",
    migrationDraft: {
      id: "ssh-draft",
      source: { kind: "ssh", transport: "ssh", label: "root@source.example.com" },
    },
    migrationSource: {
      transport: "ssh",
      privateKey: "PRIVATE KEY",
      password: "password",
      passphrase: "passphrase",
    },
  });
  const storage = installSessionStorage(JSON.stringify(staleDraft));

  try {
    const loaded = loadDeployDraft();
    const rewritten = storage.readDraft();

    assert.equal(loaded?.migrationMethod, "upload");
    assert.equal(loaded?.migrationDraft, null);
    assert.equal(loaded?.migrationSource.transport, "docker");
    assert.deepEqual(rewritten, loaded);
    assert.doesNotMatch(JSON.stringify(rewritten), /PRIVATE KEY|password|passphrase/);
  } finally {
    storage.restore();
  }
});

test("Docker Live Pull drafts preserve only the supported source fields", () => {
  const storage = installSessionStorage();

  try {
    saveDeployDraft(
      createDraft({
        migrationMethod: "live",
        migrationSource: {
          name: "Local source",
          transport: "docker",
          container: "openclaw-source",
          workspaceRoot: "/workspace",
          agentRoot: "/agent",
          sessionRoot: "/sessions",
          unexpected: "drop me",
        },
      }),
    );

    const stored = storage.readDraft();
    assert.equal(stored.migrationMethod, "live");
    assert.deepEqual(stored.migrationSource, {
      name: "Local source",
      transport: "docker",
      container: "openclaw-source",
      workspaceRoot: "/workspace",
      agentRoot: "/agent",
      sessionRoot: "/sessions",
    });
  } finally {
    storage.restore();
  }
});

test("non-SSH migration previews whitelist source metadata and remove nested credentials", () => {
  const storage = installSessionStorage();

  try {
    saveDeployDraft(
      createDraft({
        migrationDraft: {
          id: "file-draft",
          name: "Imported bundle",
          source: {
            kind: "file",
            transport: "bundle",
            label: "agent.nora-migration.tgz",
            agentId: "source-agent",
            password: "LEAK",
            apiKey: "TOKEN",
            arbitrary: "drop source extension",
          },
          managed: {
            safe: "metadata",
            accessToken: "LEAK",
          },
        },
      }),
    );

    const stored = storage.readDraft();
    assert.deepEqual(stored.migrationDraft.source, {
      kind: "file",
      transport: "bundle",
      label: "agent.nora-migration.tgz",
      agentId: "source-agent",
    });
    assert.deepEqual(stored.migrationDraft.managed, { safe: "metadata" });
    assert.doesNotMatch(JSON.stringify(stored), /LEAK|TOKEN|password|apiKey|accessToken/);
  } finally {
    storage.restore();
  }
});

test("non-live backup drafts keep restore metadata while secret-like fields are removed", () => {
  const storage = installSessionStorage();

  try {
    saveDeployDraft(
      createDraft({
        migrationMethod: "backup",
        migrationSource: {
          transport: "backup",
          backupId: "backup-123",
          name: "Nightly backup",
          password_value: "remove me",
          clientSecret: "remove client secret",
          sshKey: "remove ssh key",
          authorization: "remove authorization",
          sessionCookie: "remove cookie",
          accessKeyId: "remove access key",
          metadata: {
            key_passphrase: "remove nested secret",
            retained: "safe metadata",
          },
        },
      }),
    );

    const stored = storage.readDraft();
    assert.equal(stored.migrationMethod, "backup");
    assert.equal(stored.migrationSource.transport, "backup");
    assert.equal(stored.migrationSource.backupId, "backup-123");
    assert.equal(stored.migrationSource.name, "Nightly backup");
    assert.equal(stored.migrationSource.password_value, undefined);
    assert.deepEqual(stored.migrationSource.metadata, { retained: "safe metadata" });
    assert.doesNotMatch(
      JSON.stringify(stored),
      /remove client secret|remove ssh key|remove authorization|remove cookie|remove access key/,
    );
  } finally {
    storage.restore();
  }
});

test("deploy draft storage keeps only the versioned schema and whitelisted skill fields", () => {
  const storage = installSessionStorage();

  try {
    saveDeployDraft({
      ...createDraft(),
      apiKey: "TOP-LEVEL-LEAK",
      metadata: {
        retained: "safe metadata",
        accessToken: "NESTED-LEAK",
      },
      clawhubSkills: [
        {
          source: "clawhub",
          installSlug: "safe-skill",
          author: "nora",
          pagePath: "nora/safe-skill",
          installedAt: "2026-07-13T00:00:00.000Z",
          accessToken: "SKILL-LEAK",
        },
      ],
    } as unknown as DeployDraft);

    const stored = storage.readDraft();
    assert.equal(stored.apiKey, undefined);
    assert.equal(stored.metadata, undefined);
    assert.deepEqual(stored.clawhubSkills, [
      {
        source: "clawhub",
        installSlug: "safe-skill",
        author: "nora",
        pagePath: "nora/safe-skill",
        installedAt: "2026-07-13T00:00:00.000Z",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(stored), /TOP-LEVEL-LEAK|NESTED-LEAK|SKILL-LEAK/);
  } finally {
    storage.restore();
  }
});
