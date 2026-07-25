import { remoteHostStatus, type RemoteHost } from "../../lib/remoteHosts";

export default function RemoteHostStatusBadge({ host }: { host: RemoteHost }) {
  const status = remoteHostStatus(host);
  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${status.className}`}>
      {status.label}
    </span>
  );
}
