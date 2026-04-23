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

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function loadDeployDraft(): DeployDraft | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.sessionStorage.getItem(DEPLOY_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveDeployDraft(draft: DeployDraft) {
  if (!canUseStorage()) return;
  window.sessionStorage.setItem(DEPLOY_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function clearDeployDraft() {
  if (!canUseStorage()) return;
  window.sessionStorage.removeItem(DEPLOY_DRAFT_STORAGE_KEY);
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
