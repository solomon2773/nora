import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useI18n } from "../../lib/i18n";

// Back link shown above the header of every workspace sub-page. Pages
// reached from the Workspaces list (agents, members, settings) go back to
// the list; pages reached from a workspace's settings (API keys, alert
// rules, cost) go back to that workspace's settings.
export default function WorkspaceBackLink({
  href = "/workspaces",
  label = "Back to workspaces",
}: {
  href?: string;
  label?: string;
}) {
  const { t } = useI18n();
  return (
    <Link
      href={href}
      className="-mb-4 inline-flex w-fit items-center gap-2 text-sm font-bold text-slate-600 transition-colors hover:text-blue-600"
    >
      <ArrowLeft size={16} />
      {t(label)}
    </Link>
  );
}
