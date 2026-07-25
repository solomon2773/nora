export const DEPLOY_DRAFT_STORAGE_KEY = "nora.deployDraft.v1";

export type DeployClawHubSkill = {
  source: "clawhub";
  installSlug: string;
  author: string;
  pagePath: string;
  installedAt: string;
  name?: string;
  description?: string;
};

export type DeployDraft = {
  name: string;
  containerName: string;
  runtimeFamily: string;
  deployTarget: string;
  sandboxProfile: string;
  model: string;
  deploymentMode: string;
  migrationMethod: string;
  migrationDraft: any;
  migrationSource: any;
  vcpu: number;
  ramMb: number;
  diskGb: number;
  clawhubSkills: DeployClawHubSkill[];
};

type DraftResourceOptions = {
  defaultVcpu?: number;
  defaultRamMb?: number;
  defaultDiskGb?: number;
  maxVcpu?: number;
  maxRamMb?: number;
  maxDiskGb?: number;
};

let inMemoryDeployDraft: DeployDraft | null = null;

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage || null;
  } catch {
    // Access itself can throw when storage is disabled by the browser or an
    // embedded/private context. Deploy navigation must remain usable.
    return null;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSensitiveDraftKey(key: string) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return (
    normalized.includes("privatekey") ||
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized.includes("secret") ||
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "sshkey" ||
    normalized === "accesskey" ||
    normalized.startsWith("accesskey") ||
    normalized === "token" ||
    normalized.endsWith("token")
  );
}

function sanitizeSensitiveDraftValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeSensitiveDraftValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveDraftKey(key))
      .map(([key, entryValue]) => [key, sanitizeSensitiveDraftValue(entryValue)]),
  );
}

function sanitizeMigrationSource(source: unknown): Record<string, unknown> {
  const candidate =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const transport = stringValue(candidate.transport).trim().toLowerCase();
  const sanitizedEntries = sanitizeSensitiveDraftValue(candidate) as Record<string, unknown>;

  if (transport && transport !== "docker" && transport !== "ssh") {
    return {
      ...sanitizedEntries,
      transport,
      name: stringValue(candidate.name),
      container: stringValue(candidate.container),
      workspaceRoot: stringValue(candidate.workspaceRoot),
      agentRoot: stringValue(candidate.agentRoot),
      sessionRoot: stringValue(candidate.sessionRoot),
    };
  }

  return {
    name: stringValue(candidate.name),
    transport: "docker",
    container: stringValue(candidate.container),
    workspaceRoot: stringValue(candidate.workspaceRoot),
    agentRoot: stringValue(candidate.agentRoot),
    sessionRoot: stringValue(candidate.sessionRoot),
  };
}

function sanitizeMigrationDraftPreview(draft: unknown): Record<string, unknown> | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;

  const candidate = draft as Record<string, unknown>;
  const sanitized = sanitizeSensitiveDraftValue(candidate) as Record<string, unknown>;
  const rawSource =
    candidate.source && typeof candidate.source === "object" && !Array.isArray(candidate.source)
      ? (candidate.source as Record<string, unknown>)
      : {};

  return {
    ...sanitized,
    source: {
      kind: stringValue(rawSource.kind),
      transport: stringValue(rawSource.transport),
      label: stringValue(rawSource.label),
      agentId: stringValue(rawSource.agentId),
    },
  };
}

function sanitizeClawHubSkills(value: unknown): DeployClawHubSkill[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Record<string, unknown>;
    const installSlug = stringValue(candidate.installSlug).trim();
    if (!installSlug) return [];

    return [
      {
        source: "clawhub" as const,
        installSlug,
        author: stringValue(candidate.author),
        pagePath: stringValue(candidate.pagePath),
        installedAt: stringValue(candidate.installedAt),
        ...(stringValue(candidate.name) ? { name: stringValue(candidate.name) } : {}),
        ...(stringValue(candidate.description)
          ? { description: stringValue(candidate.description) }
          : {}),
      },
    ];
  });
}

function sanitizeDeployDraft(draft: unknown): DeployDraft | null {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;

  const candidate = draft as DeployDraft & Record<string, unknown>;
  const rawMigrationSource =
    candidate.migrationSource && typeof candidate.migrationSource === "object"
      ? (candidate.migrationSource as Record<string, unknown>)
      : {};
  const requestedTransport = stringValue(rawMigrationSource.transport).trim().toLowerCase();
  const requestedMethod = stringValue(candidate.migrationMethod).trim().toLowerCase();
  const migrationDraftSource =
    candidate.migrationDraft &&
    typeof candidate.migrationDraft === "object" &&
    candidate.migrationDraft.source &&
    typeof candidate.migrationDraft.source === "object"
      ? (candidate.migrationDraft.source as Record<string, unknown>)
      : {};
  const migrationDraftTransport = stringValue(migrationDraftSource.transport).trim().toLowerCase();
  const migrationDraftKind = stringValue(migrationDraftSource.kind).trim().toLowerCase();
  const isStaleSshDraft =
    requestedTransport === "ssh" ||
    migrationDraftTransport === "ssh" ||
    migrationDraftKind === "ssh";
  const safeMigrationMethod =
    isStaleSshDraft || (requestedMethod === "live" && requestedTransport !== "docker")
      ? "upload"
      : requestedMethod || "upload";

  return {
    name: stringValue(candidate.name),
    containerName: stringValue(candidate.containerName),
    runtimeFamily: stringValue(candidate.runtimeFamily),
    deployTarget: stringValue(candidate.deployTarget),
    sandboxProfile: stringValue(candidate.sandboxProfile),
    model: stringValue(candidate.model),
    deploymentMode: stringValue(candidate.deploymentMode) || "blank",
    migrationMethod: safeMigrationMethod,
    migrationDraft: isStaleSshDraft
      ? null
      : sanitizeMigrationDraftPreview(candidate.migrationDraft),
    migrationSource: sanitizeMigrationSource(rawMigrationSource),
    vcpu: numberValue(candidate.vcpu),
    ramMb: numberValue(candidate.ramMb),
    diskGb: numberValue(candidate.diskGb),
    clawhubSkills: sanitizeClawHubSkills(candidate.clawhubSkills),
  };
}

export function loadDeployDraft(): DeployDraft | null {
  const storage = getSessionStorage();
  if (!storage) return inMemoryDeployDraft;

  try {
    const raw = storage.getItem(DEPLOY_DRAFT_STORAGE_KEY);
    if (!raw) return inMemoryDeployDraft;
    const draft = sanitizeDeployDraft(JSON.parse(raw));
    if (!draft) return inMemoryDeployDraft;

    inMemoryDeployDraft = draft;

    // Rewrite legacy drafts immediately so SSH keys, passwords, passphrases,
    // and other no-longer-supported source fields do not remain in browser storage.
    try {
      storage.setItem(DEPLOY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // The parsed, sanitized in-memory draft is still safe to use when a
      // browser allows reads but blocks writes or reaches quota.
    }
    return draft;
  } catch {
    return inMemoryDeployDraft;
  }
}

export function saveDeployDraft(draft: DeployDraft) {
  const sanitizedDraft = sanitizeDeployDraft(draft);
  if (!sanitizedDraft) return;
  inMemoryDeployDraft = sanitizedDraft;

  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(DEPLOY_DRAFT_STORAGE_KEY, JSON.stringify(sanitizedDraft));
  } catch {
    // Storage can become unavailable or exceed quota between detection and
    // the write. The caller can continue without a cross-page draft.
  }
}

export function clearDeployDraft() {
  inMemoryDeployDraft = null;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(DEPLOY_DRAFT_STORAGE_KEY);
  } catch {
    // Treat disabled storage as already cleared.
  }
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDeployDraftResources(
  draft: DeployDraft | null,
  {
    defaultVcpu = 1,
    defaultRamMb = 1024,
    defaultDiskGb = 10,
    maxVcpu = 16,
    maxRamMb = 32768,
    maxDiskGb = 500,
  }: DraftResourceOptions = {},
) {
  return {
    vcpu: clamp(normalizeInteger(draft?.vcpu, defaultVcpu), 1, maxVcpu),
    ramMb: clamp(normalizeInteger(draft?.ramMb, defaultRamMb), 512, maxRamMb),
    diskGb: clamp(normalizeInteger(draft?.diskGb, defaultDiskGb), 10, maxDiskGb),
  };
}
