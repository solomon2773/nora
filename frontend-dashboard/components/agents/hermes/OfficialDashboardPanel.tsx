import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  LayoutDashboard,
  Loader2,
  Maximize2,
  RefreshCw,
} from "lucide-react";

const DASHBOARD_BOOT_MESSAGE =
  "Fresh Hermes deployments can take a couple of minutes while the official dashboard boots.";

export default function OfficialDashboardPanel({
  agentId,
  runtimeInfo,
  loadingRuntime,
  runtimeError,
  onRefreshRuntime,
}) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const dashboardInfo = runtimeInfo?.dashboard || null;
  const dashboardReady =
    typeof dashboardInfo?.ready === "boolean"
      ? dashboardInfo.ready
      : Boolean(runtimeInfo?.health?.ok);
  const dashboardError =
    dashboardInfo?.error || runtimeError || DASHBOARD_BOOT_MESSAGE;

  useEffect(() => {
    setIframeLoaded(false);
    setRefreshNonce(0);
  }, [agentId]);

  useEffect(() => {
    if (!dashboardReady) {
      setIframeLoaded(false);
    }
  }, [dashboardReady]);

  const embedUrl = useMemo(() => {
    if (!dashboardReady) return "";
    const jwt = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!jwt) return "";
    return `/api/agents/${agentId}/hermes-ui/embed?token=${encodeURIComponent(jwt)}`;
  }, [agentId, dashboardReady]);

  function handleRefresh() {
    setIframeLoaded(false);
    setRefreshNonce((current) => current + 1);
    onRefreshRuntime();
  }

  function openInNewWindow() {
    if (!embedUrl) return;
    const popup = window.open(embedUrl, "_blank", "noopener");
    if (!popup) {
      const link = document.createElement("a");
      link.href = embedUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }
  }

  if (loadingRuntime && !runtimeInfo) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (runtimeError && !runtimeInfo) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-8 flex flex-col items-center gap-3">
        <AlertTriangle size={32} className="text-amber-500" />
        <p className="text-sm font-bold text-slate-700">
          Official Hermes dashboard unavailable
        </p>
        <p className="text-xs text-slate-500">{runtimeError}</p>
        <button
          onClick={handleRefresh}
          className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5"
        >
          <RefreshCw size={11} /> Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col"
      style={{ height: "calc(100vh - 260px)", minHeight: "500px" }}
    >
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 rounded-t-xl border border-slate-700 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-2 h-2 rounded-full ${
              dashboardReady && iframeLoaded
                ? "bg-green-500"
                : "bg-amber-500 animate-pulse"
            }`}
          />
          <span className="text-xs font-mono text-slate-400 truncate">
            {dashboardInfo?.url || "Hermes dashboard"} &middot; Port{" "}
            {dashboardInfo?.port || "9119"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleRefresh}
            className="p-1.5 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-700"
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={openInNewWindow}
            disabled={!embedUrl}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            title="Open the official Hermes dashboard in a new window"
          >
            <Maximize2 size={12} />
            New Window
          </button>
        </div>
      </div>

      <div className="flex-1 relative rounded-b-xl border border-t-0 border-slate-700 overflow-hidden">
        {(!dashboardReady || !iframeLoaded) && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900 z-10">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <div className="space-y-1 text-center px-6">
                <p className="text-xs text-slate-400">
                  {dashboardReady
                    ? "Connecting to official Hermes dashboard..."
                    : "Preparing official Hermes dashboard..."}
                </p>
                {!dashboardReady && (
                  <p className="text-[11px] text-slate-500 max-w-md">
                    {dashboardError || DASHBOARD_BOOT_MESSAGE}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {dashboardReady && embedUrl ? (
          <iframe
            key={`${agentId}:${refreshNonce}`}
            src={embedUrl}
            className="w-full h-full border-0"
            allow="clipboard-write"
            title={`Hermes Dashboard ${agentId}`}
            onLoad={() => setIframeLoaded(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-slate-900 text-slate-500 text-sm px-6 text-center">
            {dashboardReady ? (
              "Unable to build the dashboard embed URL. Log in again and retry."
            ) : (
              <div className="flex flex-col items-center gap-2">
                <LayoutDashboard size={18} className="text-slate-600" />
                <span>Waiting for the official Hermes dashboard to become ready.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
