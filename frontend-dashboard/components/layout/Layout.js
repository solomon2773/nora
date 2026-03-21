import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import { useState, useEffect } from "react";

export default function Layout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      window.location.href = "/login";
    } else {
      setAuthChecked(true);
    }
    // Restore collapsed state
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") setSidebarCollapsed(true);
  }, []);

  const toggleCollapsed = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
  };

  if (!authChecked) return null;

  return (
    <div className="flex h-screen bg-[#f8fafc] overflow-hidden selection:bg-blue-500/20">
      {/* Sidebar - Desktop (collapsible) */}
      <div className="hidden lg:flex lg:flex-shrink-0 transition-all duration-300">
        <Sidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleCollapsed} />
      </div>

      {/* Sidebar - Mobile/Tablet Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)}></div>
          <div className="relative flex flex-col w-64 bg-slate-950 animate-in slide-in-from-left duration-300">
            <Sidebar collapsed={false} onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />

        {/* Page Content */}
        <main className="flex-1 flex flex-col overflow-hidden bg-[#f8fafc]">
          <div className="w-full flex-1 flex flex-col overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 md:px-6 lg:px-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
