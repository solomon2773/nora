// Kubernetes provider — kubeconfig-based credential. The connectivity
// test parses the kubeconfig to confirm it's well-formed YAML/JSON with a
// `clusters` entry, but does not call the API server. The cluster is
// usually behind a private network from the Nora control plane's
// perspective; the agent runtime mounts the kubeconfig into a temp file
// and runs `kubectl` from inside the agent container.

import type {
  ConnectivityResult,
  DecryptedIntegration,
  EnvMapping,
  Provider,
  ProviderDeps,
} from "../types/provider";

function parseKubeconfig(raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  // Minimal YAML probe — we don't depend on a YAML parser at the backend
  // layer. Detect the top-level "clusters:" key as a smoke test; the
  // runtime container parses the file with kubectl (which uses real YAML).
  return /^\s*clusters\s*:/m.test(trimmed) ? { __probe: "yaml" } : null;
}

export const kubernetesProvider: Provider = {
  id: "kubernetes",
  authType: "credentials",

  async test(ctx: DecryptedIntegration): Promise<ConnectivityResult> {
    try {
      const config = (ctx.config || {}) as Record<string, any>;
      const kubeconfig = String(config.kubeconfig || "").trim();
      if (!kubeconfig) throw new Error("Kubeconfig is required");
      const parsed = parseKubeconfig(kubeconfig);
      if (!parsed) throw new Error("Kubeconfig is not valid YAML/JSON or has no clusters entry");
      return {
        success: true,
        message: "Kubeconfig stored — cluster connectivity not verified from control plane",
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  },

  mapToEnv(ctx: DecryptedIntegration): EnvMapping {
    const config = ctx.config || {};
    const configEnv: Record<string, string> = {};
    if (config.kubeconfig) configEnv.kubeconfig = "KUBECONFIG_CONTENTS";
    if (config.context) configEnv.context = "KUBECONFIG_CONTEXT";
    // No primary token — kubeconfig is the credential, expressed via config envs.
    return { primary: null, config: configEnv };
  },
};
