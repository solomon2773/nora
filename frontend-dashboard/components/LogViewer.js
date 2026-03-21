import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal, WifiOff, Trash2, Download } from "lucide-react";

/**
 * Real-time log viewer that connects to the backend WebSocket log stream.
 *
 * Props:
 * - agentId: agent UUID
 * - historyRef: { current: [] } — external ref for persistent log history
 * - maxLines: max lines to keep (default 2000)
 * - visible: whether the viewer is currently visible
 */
export default function LogViewer({ agentId, historyRef, maxLines = 2000, visible = true }) {
  const [logs, setLogs] = useState(() => historyRef?.current || []);
  const [connected, setConnected] = useState(false);
  const endRef = useRef(null);
  const wsRef = useRef(null);

  // Sync to external ref
  useEffect(() => {
    if (historyRef) historyRef.current = logs;
  }, [logs, historyRef]);

  useEffect(() => {
    if (!agentId) return;

    const token = localStorage.getItem("token");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/logs/${agentId}?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Ensure each log entry has a timestamp
        if (!data.timestamp) data.timestamp = new Date().toISOString();
        setLogs((prev) => {
          const next = [...prev, data];
          if (next.length > maxLines) next.splice(0, next.length - maxLines);
          return next;
        });
      } catch (err) {
        console.error("Failed to parse log message:", err);
      }
    };

    return () => ws.close();
  }, [agentId, maxLines]);

  // Auto-scroll when visible
  useEffect(() => {
    if (visible) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, visible]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView({ behavior: "auto" });
      });
    }
  }, [visible]);

  const exportLogs = useCallback(() => {
    const text = logs.map(log => {
      const ts = log.timestamp ? `[${log.timestamp}]` : "";
      const level = log.level ? ` ${log.level}` : "";
      return `${ts}${level} ${log.message || ""}`;
    }).join("\n");

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs-${agentId}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs, agentId]);

  const levelColors = {
    INFO: "text-blue-400",
    WARN: "text-yellow-400",
    ERROR: "text-red-400",
    DEBUG: "text-slate-500",
  };

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden" style={{ height: "100%" }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-slate-500" />
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Live Logs</span>
          <span className="text-[10px] text-slate-600">{logs.length} entries</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportLogs}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
            title="Export logs"
          >
            <Download size={12} /> Export
          </button>
          <button
            onClick={() => setLogs([])}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
          >
            <Trash2 size={12} /> Clear
          </button>
          <div className="flex items-center gap-1.5">
            {connected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className="text-[10px] text-green-400 font-bold">LIVE</span>
              </>
            ) : (
              <>
                <WifiOff size={12} className="text-red-400" />
                <span className="text-[10px] text-red-400 font-bold">DISCONNECTED</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Log output */}
      <div className="overflow-y-auto p-4 font-mono text-xs leading-relaxed space-y-0.5 scrollbar-thin scrollbar-thumb-slate-800" style={{ height: "calc(100% - 45px)" }}>
        {logs.length === 0 && (
          <p className="text-slate-600 italic">Waiting for logs...</p>
        )}
        {logs.map((log, i) => (
          <div key={i} className="flex gap-2 hover:bg-white/[0.02] px-1 -mx-1 rounded">
            {log.timestamp && (
              <span className="text-slate-600 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
            )}
            {log.level && (
              <span className={`font-bold shrink-0 w-12 ${levelColors[log.level] || "text-slate-400"}`}>
                {log.level}
              </span>
            )}
            <span
              className={
                log.type === "system"
                  ? "text-cyan-400"
                  : log.type === "error"
                  ? "text-red-400"
                  : "text-slate-300"
              }
            >
              {log.message}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
