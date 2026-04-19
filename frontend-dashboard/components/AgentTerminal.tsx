import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as TermIcon, WifiOff, Maximize2, Minimize2, Download, RefreshCw } from "lucide-react";

const TOOLBAR_HEIGHT = 37;

/**
 * xterm.js-backed terminal.
 *
 * Props:
 * - agentId: agent UUID
 * - historyRef: { current: [] } — unused (kept for API compat), xterm manages its own buffer
 * - wsRef: { current: null } — external ref for persistent WebSocket
 * - visible: whether the terminal is currently visible (triggers fit on show)
 */
export default function AgentTerminal({ agentId, historyRef, wsRef: externalWsRef, visible = true }) {
  const termContainerRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const internalWsRef = useRef(null);
  const wsRef = externalWsRef || internalWsRef;
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [expanded, setExpanded] = useState(false);
  const [xtermReady, setXtermReady] = useState(false);

  // Initialize xterm.js (dynamic import to avoid SSR issues with Next.js)
  useEffect(() => {
    let term;
    let fitAddon;
    let disposed = false;

    async function init() {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      // Import xterm CSS
      await import("@xterm/xterm/css/xterm.css");

      if (disposed) return;

      term = new Terminal({
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        cursorStyle: "block",
        theme: {
          background: "#0a0e1a",
          foreground: "#e2e8f0",
          cursor: "#60a5fa",
          selectionBackground: "rgba(96, 165, 250, 0.3)",
          black: "#1e293b",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#e2e8f0",
          brightBlack: "#475569",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#facc15",
          brightBlue: "#60a5fa",
          brightMagenta: "#c084fc",
          brightCyan: "#22d3ee",
          brightWhite: "#f8fafc",
        },
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      if (termContainerRef.current) {
        term.open(termContainerRef.current);
        fitAddon.fit();
      }

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      setXtermReady(true);
    }

    init();

    return () => {
      disposed = true;
      if (term) term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      setXtermReady(false);
    };
  }, []);

  // Fit terminal on resize, visibility change, or expand/collapse
  useEffect(() => {
    if (!fitAddonRef.current || !visible) return;
    const fit = () => {
      try { fitAddonRef.current.fit(); } catch {}
    };
    // Delay fit to let DOM settle after expand/collapse
    const timer = setTimeout(fit, 50);
    window.addEventListener("resize", fit);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", fit);
    };
  }, [visible, expanded, xtermReady]);

  // Connect / reconnect WebSocket
  const connectWs = useCallback(() => {
    if (!agentId || !xtermRef.current) return;
    // Close existing connection if any
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    setStatus("Connecting...");

    const token = localStorage.getItem("token");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/exec/${agentId}?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    const term = xtermRef.current;

    ws.onopen = () => {
      setConnected(true);
      setStatus("Connected");
      // Send terminal dimensions
      const dims = fitAddonRef.current?.proposeDimensions();
      ws.send(JSON.stringify({ type: "resize", cols: dims?.cols || 120, rows: dims?.rows || 40 }));
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus("Disconnected");
      term.writeln("\r\n\x1b[90m--- Session ended ---\x1b[0m");
    };

    ws.onerror = () => {
      setConnected(false);
      setStatus("Connection error");
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "output") term.write(msg.data);
        else if (msg.type === "system") term.writeln(`\x1b[36m${msg.message}\x1b[0m`);
        else if (msg.type === "error") term.writeln(`\x1b[31m${msg.message}\x1b[0m`);
      } catch {
        term.write(e.data);
      }
    };

  }, [agentId, xtermReady]);

  // Wire xterm input/resize to WebSocket — uses wsRef so it works across reconnects
  useEffect(() => {
    if (!xtermReady || !xtermRef.current) return;
    const term = xtermRef.current;

    const dataDisposable = term.onData((data) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
    };
  }, [xtermReady]);

  // Initial connection (after xterm is ready)
  useEffect(() => {
    if (!xtermReady) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setConnected(true);
      setStatus("Connected");
      return;
    }
    connectWs();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connectWs, xtermReady]);

  // Focus terminal when becoming visible
  useEffect(() => {
    if (visible && xtermRef.current) {
      requestAnimationFrame(() => {
        xtermRef.current.focus();
        try { fitAddonRef.current?.fit(); } catch {}
      });
    }
  }, [visible]);

  // Export terminal buffer as text file
  const exportHistory = useCallback(() => {
    if (!xtermRef.current) return;
    const term = xtermRef.current;
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const text = lines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-${agentId}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [agentId]);

  return (
    <div
      className={`bg-[#0a0e1a] border border-slate-800 rounded-2xl overflow-hidden flex flex-col ${
        expanded ? "fixed inset-4 z-50 shadow-2xl" : "w-full"
      }`}
      style={expanded ? {} : { height: "100%" }}
    >
      {/* Toolbar */}
      <div
        style={{ height: TOOLBAR_HEIGHT, flexShrink: 0 }}
        className="flex items-center justify-between px-4 border-b border-slate-800 bg-slate-900/50"
      >
        <div className="flex items-center gap-2">
          <TermIcon size={14} className="text-slate-500" />
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Terminal</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportHistory}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
            title="Export terminal history"
          >
            <Download size={12} /> Export
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
            title={expanded ? "Minimize" : "Maximize"}
          >
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <div className="flex items-center gap-1.5">
            {connected ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <span className="text-[10px] text-green-400 font-bold">{status}</span>
              </>
            ) : (
              <>
                <WifiOff size={12} className="text-red-400" />
                <span className="text-[10px] text-red-400 font-bold">{status}</span>
                <button
                  onClick={connectWs}
                  className="ml-1 flex items-center gap-1 px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-[10px] font-bold rounded transition-colors"
                  title="Reconnect terminal"
                >
                  <RefreshCw size={10} />
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Terminal container — xterm.js renders here */}
      <div
        ref={termContainerRef}
        onClick={() => xtermRef.current?.focus()}
        className="flex-1 overflow-hidden"
        style={{ height: `calc(100% - ${TOOLBAR_HEIGHT}px)`, backgroundColor: "#0a0e1a" }}
      />
    </div>
  );
}
