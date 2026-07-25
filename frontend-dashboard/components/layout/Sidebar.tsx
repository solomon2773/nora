import { useRouter } from "next/router";
import {
  LayoutDashboard,
  Bot,
  Rocket,
  BarChart3,
  FolderOpen,
  ListChecks,
  Settings,
  Server,
  ScrollText,
  PanelLeftClose,
  PanelLeftOpen,
  ShoppingBag,
  GitBranch,
  ExternalLink,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { useI18n } from "../../lib/i18n";

type SidebarProps = {
  collapsed?: boolean;
  onToggleCollapse?: (() => void) | null;
  onClose?: (() => void) | null;
  platformMode?: string | null;
};
type NavItem = {
  name: string;
  icon: typeof LayoutDashboard;
  href: string;
  selfHostedOnly?: boolean;
};

const REPO_URL = "https://github.com/solomon2773/nora";
const NAV_ITEMS: NavItem[] = [
  { name: "Dashboard", icon: LayoutDashboard, href: "/app/dashboard" },
  { name: "Getting Started", icon: ListChecks, href: "/app/getting-started" },
  { name: "Agents", icon: Bot, href: "/app/agents" },
  { name: "Agent Hub", icon: ShoppingBag, href: "/app/agent-hub" },
  { name: "Deploy", icon: Rocket, href: "/app/deploy" },
  {
    name: "Remote Hosts",
    icon: Server,
    href: "/app/remote-hosts",
    selfHostedOnly: true,
  },
  { name: "Workspaces", icon: FolderOpen, href: "/app/workspaces" },
  { name: "Monitoring", icon: BarChart3, href: "/app/monitoring" },
  { name: "Logs", icon: ScrollText, href: "/app/logs" },
];

export default function Sidebar({
  collapsed = false,
  onToggleCollapse,
  onClose,
  platformMode = null,
}: SidebarProps) {
  const router = useRouter();
  const { localizePath, t } = useI18n();
  const navItems = NAV_ITEMS.filter(
    (item) => !item.selfHostedOnly || platformMode === "selfhosted",
  );

  const isActive = (path) => {
    const normalized = path.replace(/^\/app/, "") || "/";
    return router.pathname === normalized;
  };

  return (
    <aside
      aria-label={t("Primary navigation")}
      className={clsx(
        "bg-brand-ink text-brand-foreground flex flex-col border-r border-brand-cyan/10 shadow-2xl z-50 overflow-y-auto transition-all duration-300",
        collapsed ? "w-[68px]" : "w-64",
      )}
    >
      {/* Header */}
      <div
        className={clsx(
          "flex items-center gap-3 shrink-0",
          collapsed ? "p-4 justify-center" : "p-6 pb-8",
        )}
      >
        <img
          src="/app/logo-mark.png"
          alt="Nora"
          width={40}
          height={40}
          className="w-10 h-10 shrink-0"
        />
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            <span className="text-xl font-bold tracking-tight leading-none text-brand-foreground">
              Nora
            </span>
            <span className="mt-1 text-[10px] font-black uppercase tracking-widest text-brand-cyan/70">
              {t("Deploy intelligence anywhere.")}
            </span>
          </div>
        )}
        {/* Mobile close button */}
        {onClose && !collapsed && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close navigation menu")}
            className="ml-auto rounded-lg p-1.5 text-brand-foreground/50 transition-colors hover:bg-brand-cyan/10 hover:text-brand-foreground lg:hidden"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav Items */}
      <nav className={clsx("flex-1 space-y-1", collapsed ? "px-2" : "px-4")}>
        {!collapsed && (
          <div className="mb-4 flex items-center gap-2 px-4 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-cyan/55">
            {t("Main Operations")}
            <div className="ml-2 h-[1px] flex-1 bg-brand-cyan/10"></div>
          </div>
        )}

        {navItems.map((item) => (
          <a
            key={item.name}
            href={localizePath(item.href)}
            className="block"
            title={collapsed ? t(item.name) : undefined}
            aria-label={collapsed ? t(item.name) : undefined}
            aria-current={isActive(item.href) ? "page" : undefined}
          >
            <div
              className={clsx(
                "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group relative",
                collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
                isActive(item.href)
                  ? "bg-brand-cyan text-brand-ink shadow-lg shadow-brand-cyan/20"
                  : "text-brand-foreground/62 hover:bg-brand-cyan/10 hover:text-brand-foreground",
              )}
            >
              <item.icon
                size={18}
                className={clsx(
                  "transition-transform group-hover:scale-110 shrink-0",
                  isActive(item.href)
                    ? "text-brand-ink"
                    : "text-brand-foreground/42 group-hover:text-brand-cyan",
                )}
              />
              {!collapsed && t(item.name)}

              {isActive(item.href) && (
                <div
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand-ink"
                ></div>
              )}
            </div>
          </a>
        ))}
      </nav>

      {/* Footer */}
      <div
        className={clsx(
          "mt-auto space-y-1 border-t border-brand-cyan/10",
          collapsed ? "p-2" : "p-4",
        )}
      >
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="block"
          title={collapsed ? t("GitHub Repo") : undefined}
          aria-label={t("GitHub Repo")}
        >
          <div
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group text-brand-foreground/50 hover:bg-brand-cyan/10 hover:text-brand-foreground",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
            )}
          >
            <GitBranch size={18} className="shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1">{t("GitHub Repo")}</span>
                <ExternalLink
                  size={14}
                  className="text-brand-foreground/35 group-hover:text-brand-cyan"
                />
              </>
            )}
          </div>
        </a>

        <a
          href={localizePath("/app/settings")}
          className="block"
          title={collapsed ? t("Settings") : undefined}
          aria-label={collapsed ? t("Settings") : undefined}
          aria-current={isActive("/app/settings") ? "page" : undefined}
        >
          <div
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
              isActive("/app/settings")
                ? "bg-brand-cyan/16 text-brand-foreground"
                : "text-brand-foreground/50 hover:bg-brand-cyan/10 hover:text-brand-foreground",
            )}
          >
            <Settings size={18} className="shrink-0" />
            {!collapsed && t("Settings")}
          </div>
        </a>

        {/* Collapse toggle — desktop only */}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all w-full text-brand-foreground/50 hover:bg-brand-cyan/10 hover:text-brand-foreground",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
            )}
            title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            {!collapsed && t("Collapse")}
          </button>
        )}
      </div>
    </aside>
  );
}
