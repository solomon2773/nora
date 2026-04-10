import { useState, useEffect, useRef } from "react";
import { Loader2, AlertTriangle, RefreshCw, Maximize2 } from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";

const GATEWAY_READY_POLL_MS = 5000;
const GATEWAY_BOOT_MESSAGE =
  "Fresh deployments can take a couple of minutes while OpenClaw installs and starts.";

export default function OpenClawUIPanel({ agentId }) {
  const [loading, setLoading] = useState(true);
  const [gatewayReady, setGatewayReady] = useState(false);
  const [gatewayBootMessage, setGatewayBootMessage] = useState("");
  const [error, setError] = useState(null);
  const [gatewayInfo, setGatewayInfo] = useState(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef(null);
  const readyPollRef = useRef(null);
  const cancelledRef = useRef(false);

  function clearReadyPoll() {
    if (readyPollRef.current) {
      clearTimeout(readyPollRef.current);
      readyPollRef.current = null;
    }
  }

  function scheduleReadyPoll() {
    clearReadyPoll();
    if (typeof window === "undefined") return;
    readyPollRef.current = window.setTimeout(() => {
      checkGatewayReady();
    }, GATEWAY_READY_POLL_MS);
  }

  async function checkGatewayReady() {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/status`);
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { error: raw || `HTTP ${res.status}` };
      }

      if (cancelledRef.current) return false;

      if (res.ok && data.health?.ok) {
        setGatewayReady(true);
        setGatewayBootMessage("");
        return true;
      }

      setGatewayReady(false);
      setGatewayBootMessage(data.error || GATEWAY_BOOT_MESSAGE);
      scheduleReadyPoll();
      return false;
    } catch (e) {
      if (cancelledRef.current) return false;
      setGatewayReady(false);
      setGatewayBootMessage(e.message || GATEWAY_BOOT_MESSAGE);
      scheduleReadyPoll();
      return false;
    }
  }

  async function fetchInfo() {
    clearReadyPoll();
    setLoading(true);
    setError(null);
    setGatewayReady(false);
    setGatewayBootMessage("");
    setIframeLoaded(false);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway-url`);
      const info = res.ok
        ? await res.json()
        : await res.json().then((e) => {
            throw new Error(e.error);
          });

      if (cancelledRef.current) return;

      setGatewayInfo(info);
      await checkGatewayReady();
    } catch (e) {
      if (cancelledRef.current) return;
      setError(e.message);
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    cancelledRef.current = false;
    if (agentId) {
      fetchInfo();
    }
    return () => {
      cancelledRef.current = true;
      clearReadyPoll();
    };
  }, [agentId]);

  // Build the same-origin embed URL (proxied through the backend, no cross-origin issues)
  function getEmbedUrl() {
    if (!gatewayInfo || !gatewayReady) return "";
    const jwt = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!jwt) return "";
    return `/api/agents/${agentId}/gateway/embed?token=${encodeURIComponent(jwt)}`;
  }

  // Open the same-origin embedded gateway UI in a new window without exposing the gateway password.
  function openInNewWindow() {
    const url = getEmbedUrl();
    if (!url) return;
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
          <div className={`w-2 h-2 rounded-full ${gatewayReady && iframeLoaded ? "bg-green-500" : "bg-amber-500 animate-pulse"}`} />
          <span className="text-xs font-mono text-slate-400">
            {gatewayInfo?.url || "—"} &middot; Port {gatewayInfo?.port || "—"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchInfo}
            className="p-1.5 text-slate-400 hover:text-white transition-colors rounded-lg hover:bg-slate-700"
            title="Reload"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={openInNewWindow}
            disabled={!embedUrl}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
            title="Open embedded gateway UI in a new window"
          >
            <Maximize2 size={12} />
            New Window
          </button>
        </div>
      </div>

      {/* Embedded Gateway UI */}
      <div className="flex-1 relative rounded-b-xl border border-t-0 border-slate-700 overflow-hidden">
        {/* Loading overlay */}
        {(!gatewayReady || !iframeLoaded) && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900 z-10">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-blue-500" />
              <div className="space-y-1 text-center px-6">
                <p className="text-xs text-slate-400">
                  {gatewayReady ? "Connecting to gateway..." : "Preparing gateway..."}
                </p>
                {!gatewayReady && (
                  <p className="text-[11px] text-slate-500 max-w-md">
                    {gatewayBootMessage || GATEWAY_BOOT_MESSAGE}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        {gatewayReady && embedUrl ? (
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
          <div className="flex items-center justify-center h-full bg-slate-900 text-slate-500 text-sm px-6 text-center">
            {gatewayReady
              ? "Unable to build embed URL — please log in again"
              : "Waiting for the embedded control UI to become ready."}
          </div>
        )}
      </div>
    </div>
  );
}
