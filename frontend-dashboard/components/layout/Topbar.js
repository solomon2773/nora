import { Bell, Search, User, LogOut, ChevronDown, CheckCircle2, Menu } from "lucide-react";
import { useState, useEffect } from "react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";

export default function Topbar({ onMenuClick }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    fetchWithAuth("/api/auth/me")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setUser(data); })
      .catch(() => {});
  }, []);

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const initial = displayName.charAt(0).toUpperCase();
  const role = user?.role || "member";

  return (
    <div className="h-16 md:h-20 bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 md:px-8 flex items-center justify-between z-40 sticky top-0">
      <div className="flex items-center gap-4">
        {/* Mobile Menu Button */}
        <button className="lg:hidden p-2 text-slate-500 hover:bg-slate-50 rounded-xl transition-all" onClick={onMenuClick}>
           <Menu size={24} />
        </button>

        {/* Search Section - Hidden on mobile, show on desktop */}
        <div className="hidden md:flex relative group items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-2 w-72 lg:w-96 transition-all focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:bg-white focus-within:border-blue-500/30">
          <Search size={18} className="text-slate-400 group-focus-within:text-blue-500" />
          <input
            className="bg-transparent border-none outline-none text-sm font-medium text-slate-900 placeholder:text-slate-400 w-full"
            placeholder="Search agents..."
          />
          <div className="hidden lg:flex items-center gap-1.5 px-1.5 py-0.5 rounded-md bg-white border border-slate-200 text-[10px] font-black text-slate-400 shadow-sm uppercase tracking-tighter">
            Ctrl + K
          </div>
        </div>
      </div>

      {/* Right Side Icons & Profile */}
      <div className="flex items-center gap-3 md:gap-6">
        <div className="flex items-center gap-2 md:gap-4 md:border-r md:border-slate-200 pr-3 md:pr-6">
           <button className="relative p-2 md:p-2.5 rounded-xl text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-all group">
             <Bell size={20} />
             <div className="absolute top-1.5 md:top-2 right-1.5 md:right-2 w-2 h-2 bg-blue-600 rounded-full ring-2 ring-white"></div>
           </button>
           <div className="hidden md:flex flex-col items-end">
              <span className="text-xs font-bold text-emerald-600 flex items-center gap-1 leading-none mb-1 whitespace-nowrap">
                 <CheckCircle2 size={12} />
                 Operational
              </span>
           </div>
        </div>

        <div className="relative">
           <button 
             className="flex items-center gap-2 md:gap-3 p-1 rounded-xl hover:bg-slate-50 transition-all border border-transparent hover:border-slate-200"
             onClick={() => setUserMenuOpen(!userMenuOpen)}
           >
             <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20 text-sm md:text-base">
                {initial}
             </div>
             <div className="hidden sm:flex flex-col items-start mr-2">
                <span className="text-sm font-bold text-slate-900 leading-none">{displayName}</span>
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 opacity-70 leading-none">{role}</span>
             </div>
             <ChevronDown size={14} className={clsx("text-slate-400 transition-transform hidden sm:block", userMenuOpen ? "rotate-180" : "")} />
           </button>
           
           {userMenuOpen && (
              <div className="absolute right-0 top-12 md:top-14 w-48 bg-white border border-slate-200 rounded-2xl shadow-xl p-2 z-[60] animate-in fade-in zoom-in-95 duration-200">
                 <div className="flex items-center gap-3 p-3 text-red-600 hover:bg-red-50 rounded-xl transition-all text-sm font-medium cursor-pointer" onClick={() => { localStorage.removeItem("token"); fetch("/api/auth/signout", { method: "POST" }).catch(() => {}); window.location.href = "/login"; }}>
                    <LogOut size={16} />
                    Log Out
                 </div>
              </div>
           )}
        </div>
      </div>
    </div>
  );
}
