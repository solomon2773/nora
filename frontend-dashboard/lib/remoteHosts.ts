export type RemoteHostAccess = {
  access?: string | null;
  managementScope?: string | null;
};

export function isOwnedRemoteHost(host: RemoteHostAccess | null | undefined) {
  return host?.access === "owned";
}

export function partitionRemoteHosts<T extends RemoteHostAccess>(hosts: T[] = []) {
  const owned: T[] = [];
  const accessible: T[] = [];

  for (const host of hosts) {
    if (isOwnedRemoteHost(host)) owned.push(host);
    else accessible.push(host);
  }

  return { owned, accessible };
}

export function remoteHostAccessSource(host: RemoteHostAccess | null | undefined) {
  if (host?.access === "user" || host?.access === "direct") return "shared directly with you";
  if (host?.access === "group") return "via a user group";
  if (host?.access === "workspace" || host?.access === "shared") return "via a workspace";
  if (
    host?.managementScope === "platform" ||
    ["platform", "global", "admin"].includes(host?.access || "")
  ) {
    return "via platform access";
  }
  return "via a workspace";
}
