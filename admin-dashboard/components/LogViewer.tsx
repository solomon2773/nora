import { useEffect, useRef, useState } from "react";
import { Download, Terminal, Trash2, WifiOff } from "lucide-react";

export default function LogViewer({
  agentId,
  historyRef,
  maxLines = 1500,
  className = "",
}) {
  const [logs, setLogs] = useState(() => historyRef?.current || []);
  const [connected, setConnected] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    if (historyRef) {
      historyRef.current = logs;
    }
  }, [logs, historyRef]);

  useEffect(() => {
    if (!agentId) return undefined;

    const token = localStorage.getItem("token");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/ws/logs/${agentId}?token=${token}`;

    const socket = new WebSocket(url);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onerror = () => setConnected(false);
    socket.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (!parsed.timestamp) {
          parsed.timestamp = new Date().toISOString();
        }

        setLogs((current) => {
          const next = [...current, parsed];
          if (next.length > maxLines) {
            next.splice(0, next.length - maxLines);
          }
          return next;
        });
      } catch (error) {
        console.error("Failed to parse admin log event:", error);
      }
    };

    return () => socket.close();
  }, [agentId, maxLines]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  function exportLogs() {
    const body = logs
      .map((entry) => {
        const timestamp = entry.timestamp ? `[${entry.timestamp}]` : "";
        const level = entry.level ? ` ${entry.level}` : "";
        return `${timestamp}${level} ${entry.message || ""}`.trim();
      })
      .join("\n");

    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `admin-logs-${agentId}-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, "-")}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const levelColors = {
    INFO: "text-blue-300",
    WARN: "text-amber-300",
    ERROR: "text-red-300",
    DEBUG: "text-slate-400",
  };

  return (
    <div
      className={`overflow-hidden rounded-[1.75rem] border border-slate-800 bg-slate-950 ${className}`}
    >
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/80 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
          <Terminal size={14} className="text-slate-500" />
          Live Logs
          <span className="text-[10px] font-semibold tracking-[0.12em] text-slate-600">
            {logs.length} entries
          </span>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={exportLogs}
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 transition-colors hover:text-slate-200"
          >
            <Download size={12} />
            Export
          </button>
          <button
            onClick={() => setLogs([])}
            className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 transition-colors hover:text-slate-200"
          >
            <Trash2 size={12} />
            Clear
          </button>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em]">
            {connected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <span className="text-emerald-400">Live</span>
              </>
            ) : (
              <>
                <WifiOff size={12} className="text-red-400" />
                <span className="text-red-400">Offline</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="h-[420px] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {logs.length === 0 ? (
          <p className="italic text-slate-600">Waiting for logs...</p>
        ) : null}

        <div className="space-y-1.5">
          {logs.map((entry, index) => (
            <div
              key={`${entry.timestamp || "log"}-${index}`}
              className="flex gap-2 rounded-lg px-2 py-1 hover:bg-white/[0.03]"
            >
              <span className="shrink-0 text-slate-600">
                {entry.timestamp
                  ? new Date(entry.timestamp).toLocaleTimeString()
                  : "--:--:--"}
              </span>
              {entry.level ? (
                <span
                  className={`w-12 shrink-0 font-bold ${levelColors[entry.level] || "text-slate-400"}`}
                >
                  {entry.level}
                </span>
              ) : null}
              <span
                className={
                  entry.type === "system"
                    ? "text-cyan-300"
                    : entry.type === "error"
                    ? "text-red-300"
                    : "text-slate-200"
                }
              >
                {entry.message}
              </span>
            </div>
          ))}
        </div>
        <div ref={endRef} />
      </div>
    </div>
  );
}
