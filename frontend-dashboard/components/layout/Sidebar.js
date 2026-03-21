import { useRouter } from "next/router";
import {
  LayoutDashboard, Bot, Rocket, BarChart3,
  Settings, ScrollText, PanelLeftClose, PanelLeftOpen, X
} from "lucide-react";
import { clsx } from "clsx";

export default function Sidebar({ collapsed = false, onToggleCollapse, onClose }) {
  const router = useRouter();

  const navItems = [
    { name: "Dashboard", icon: LayoutDashboard, href: "/app/dashboard" },
    { name: "Agents", icon: Bot, href: "/app/agents" },
    { name: "Deploy", icon: Rocket, href: "/app/deploy" },
    { name: "Monitoring", icon: BarChart3, href: "/app/monitoring" },
    { name: "Logs", icon: ScrollText, href: "/app/logs" },
  ];

  const isActive = (path) => router.pathname === path;

  return (
    <div
      className={clsx(
        "bg-slate-950 text-white flex flex-col border-r border-white/5 shadow-2xl z-50 overflow-y-auto transition-all duration-300",
        collapsed ? "w-[68px]" : "w-64"
      )}
    >
      {/* Header */}
      <div className={clsx("flex items-center gap-3 shrink-0", collapsed ? "p-4 justify-center" : "p-6 pb-8")}>
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center font-bold text-2xl shadow-lg shadow-blue-500/20 text-white shrink-0">
          N
        </div>
        {!collapsed && (
          <div className="flex flex-col min-w-0">
            <span className="text-xl font-bold tracking-tight leading-none text-white">Nora</span>
            <span className="text-[10px] text-slate-500 uppercase font-black tracking-widest mt-1 opacity-80">Cloud Director</span>
          </div>
        )}
        {/* Mobile close button */}
        {onClose && !collapsed && (
          <button onClick={onClose} className="ml-auto p-1.5 text-slate-500 hover:text-white rounded-lg hover:bg-white/10 transition-colors lg:hidden">
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav Items */}
      <div className={clsx("flex-1 space-y-1", collapsed ? "px-2" : "px-4")}>
        {!collapsed && (
          <div className="text-[10px] text-slate-500 font-bold px-4 mb-4 uppercase tracking-[0.2em] opacity-60 flex items-center gap-2">
            Main Operations
            <div className="flex-1 h-[1px] bg-white/5 ml-2"></div>
          </div>
        )}

        {navItems.map((item) => (
          <a key={item.name} href={item.href} className="block" title={collapsed ? item.name : undefined}>
            <div className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group relative",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
              isActive(item.href)
                ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                : "text-slate-400 hover:text-white hover:bg-white/5"
            )}>
              <item.icon size={18} className={clsx(
                "transition-transform group-hover:scale-110 shrink-0",
                isActive(item.href) ? "text-white" : "text-slate-500 group-hover:text-blue-400"
              )} />
              {!collapsed && item.name}

              {isActive(item.href) && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-white rounded-r-full"></div>
              )}
            </div>
          </a>
        ))}
      </div>

      {/* Footer */}
      <div className={clsx("mt-auto border-t border-white/5 space-y-1", collapsed ? "p-2" : "p-4")}>
        <a href="/app/settings" className="block" title={collapsed ? "Settings" : undefined}>
          <div className={clsx(
            "flex items-center gap-3 rounded-xl text-sm font-medium transition-all group",
            collapsed ? "justify-center px-2 py-3" : "px-4 py-3",
            isActive("/app/settings") ? "bg-white/10 text-white" : "text-slate-500 hover:text-white hover:bg-white/5"
          )}>
            <Settings size={18} className="shrink-0" />
            {!collapsed && "Settings"}
          </div>
        </a>

        {/* Collapse toggle — desktop only */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className={clsx(
              "flex items-center gap-3 rounded-xl text-sm font-medium transition-all w-full text-slate-500 hover:text-white hover:bg-white/5",
              collapsed ? "justify-center px-2 py-3" : "px-4 py-3"
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            {!collapsed && "Collapse"}
          </button>
        )}
      </div>
    </div>
  );
}
