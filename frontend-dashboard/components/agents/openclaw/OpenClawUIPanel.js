import { useState, useEffect, useRef } from "react";
import { Loader2, AlertTriangle, RefreshCw, Maximize2, Copy, Check } from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";

export default function OpenClawUIPanel({ agentId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [gatewayInfo, setGatewayInfo] = useState(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef(null);

  function copyPassword() {
    if (!gatewayInfo?.token) return;
    navigator.clipboard.writeText(gatewayInfo.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function fetchInfo() {
    setLoading(true);
    setError(null);
    setIframeLoaded(false);
    fetchWithAuth(`/api/agents/${agentId}/gateway-url`)
      .then((r) => r.ok ? r.json() : r.json().then(e => { throw new Error(e.error); }))
      .then((info) => { setGatewayInfo(info); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }

  useEffect(() => { if (agentId) fetchInfo(); }, [agentId]);

  // Build the same-origin embed URL (proxied through the backend, no cross-origin issues)
  function getEmbedUrl() {
    if (!gatewayInfo) return "";
    const jwt = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!jwt) return "";
    return `/api/agents/${agentId}/gateway/embed?token=${encodeURIComponent(jwt)}`;
  }

  // Direct host port URL for opening in a new window (no iframe restrictions)
  function openInNewWindow() {
    if (!gatewayInfo) return;
    const url = `${gatewayInfo.url}#password=${encodeURIComponent(gatewayInfo.token)}`;
    // Use _blank and noopener to avoid popup blocker issues
    const w = window.open(url, "_blank", "noopener");
    // Fallback: if popup was blocked, navigate via a temporary anchor
    if (!w) {
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.click();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-8 flex flex-col items-center gap-3">
        <AlertTriangle size={32} className="text-amber-500" />
        <p className="text-sm font-bold text-slate-700">Gateway UI unavailable</p>
        <p className="text-xs text-slate-500">{error}</p>
        <button onClick={fetchInfo} className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5">
          <RefreshCw size={11} /> Retry
        </button>
      </div>
    );
  }

  const embedUrl = getEmbedUrl();

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 260px)", minHeight: "500px" }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 rounded-t-xl border border-slate-700 shrink-0">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${iframeLoaded ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
          <span className="text-xs font-mono text-slate-400">
            {gatewayInfo?.url || "—"} &middot; Port {gatewayInfo?.port || "—"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyPassword}
            className="px-2.5 py-1.5 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-700 text-xs flex items-center gap-1.5"
            title="Copy gateway password"
          >
            {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
            {copied ? "Copied" : "Password"}
          </button>
          <button
            onClick={fetchInfo}
            className="p-1.5 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-700"
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={openInNewWindow}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-lg shadow-blue-600/20"
            title="Open in new window"
          >
            <Maximize2 size={12} />
            New Window
          </button>
        </div>
      </div>

      {/* Embedded Gateway UI */}
      <div className="flex-1 relative rounded-b-xl border border-t-0 border-slate-700 overflow-hidden">
        {/* Loading overlay */}
        {!iframeLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900 z-10">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <p className="text-xs text-slate-400">Connecting to gateway...</p>
            </div>
          </div>
        )}
        {embedUrl ? (
          <iframe
            key={agentId}
            ref={iframeRef}
            src={embedUrl}
            className="w-full h-full border-0"
            allow="clipboard-write"
            title={`OpenClaw Agent ${agentId}`}
            onLoad={() => setIframeLoaded(true)}
          />
        ) : (
          <div className="flex items-center justify-center h-full bg-slate-900 text-slate-500 text-sm">
            Unable to build embed URL — please log in again
          </div>
        )}
      </div>
    </div>
  );
}
