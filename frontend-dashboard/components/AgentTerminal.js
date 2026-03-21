import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal as TermIcon, WifiOff, Maximize2, Minimize2, Download } from "lucide-react";

const TOOLBAR_HEIGHT = 37;

// Parse ANSI color codes into spans with CSS classes
function parseAnsi(text) {
  const colorMap = {
    "30": "ansi-black", "31": "ansi-red", "32": "ansi-green", "33": "ansi-yellow",
    "34": "ansi-blue", "35": "ansi-magenta", "36": "ansi-cyan", "37": "ansi-white",
    "90": "ansi-bright-black", "91": "ansi-bright-red", "92": "ansi-bright-green",
    "93": "ansi-bright-yellow", "94": "ansi-bright-blue", "95": "ansi-bright-magenta",
    "96": "ansi-bright-cyan", "97": "ansi-bright-white",
    "1": "ansi-bold", "0": "",
  };
  const parts = [];
  let currentClass = "";
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), className: currentClass });
    }
    const codes = match[1].split(";");
    for (const code of codes) {
      if (code === "0" || code === "") currentClass = "";
      else if (colorMap[code]) currentClass = colorMap[code];
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), className: currentClass });
  }
  return parts;
}

// Strip non-color ANSI sequences
function stripControlSequences(text) {
  return text
    .replace(/\x1b\[[0-9;]*[A-HJKSTfhilmnsu]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[>=<]/g, "");
}

/**
 * Pure HTML terminal.
 *
 * Props:
 * - agentId: agent UUID
 * - historyRef: { current: [] } — external ref for persistent line history
 * - wsRef: { current: null } — external ref for persistent WebSocket
 * - maxLines: max lines to keep (default 2000)
 * - visible: whether the terminal is currently visible (controls auto-scroll)
 */
export default function AgentTerminal({ agentId, historyRef, wsRef: externalWsRef, maxLines = 2000, visible = true }) {
  const outputRef = useRef(null);
  const internalWsRef = useRef(null);
  const wsRef = externalWsRef || internalWsRef;
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Connecting...");
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState(() => historyRef?.current || []);

  // Sync lines to external historyRef so parent can persist them
  useEffect(() => {
    if (historyRef) historyRef.current = lines;
  }, [lines, historyRef]);

  const appendOutput = useCallback((text, className = "") => {
    const cleaned = stripControlSequences(text);
    const parts = cleaned.split(/\r?\n/);

    setLines(prev => {
      const next = [...prev];
      for (let i = 0; i < parts.length; i++) {
        const parsed = parseAnsi(parts[i]);
        if (i === 0 && next.length > 0) {
          const last = next[next.length - 1];
          next[next.length - 1] = { parts: [...last.parts, ...parsed.map(p => ({ ...p, className: p.className || className }))], ts: last.ts };
        } else {
          next.push({ parts: parsed.map(p => ({ ...p, className: p.className || className })), ts: new Date().toISOString() });
        }
      }
      if (next.length > maxLines) next.splice(0, next.length - maxLines);
      return next;
    });
  }, [maxLines]);

  // Auto-scroll when visible
  useEffect(() => {
    if (visible && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, visible]);

  // Scroll to bottom and focus when becoming visible again
  useEffect(() => {
    if (visible && outputRef.current) {
      requestAnimationFrame(() => {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
        outputRef.current.focus();
      });
    }
  }, [visible]);

  // WebSocket connection
  useEffect(() => {
    if (!agentId) return;
    // If we already have a live connection, don't create a new one
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setConnected(true);
      setStatus("Connected");
      return;
    }

    const token = localStorage.getItem("token");
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ws/exec/${agentId}?token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus("Connected");
      ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus("Disconnected");
      appendOutput("\n--- Session ended ---\n", "ansi-bright-black");
    };

    ws.onerror = () => {
      setConnected(false);
      setStatus("Connection error");
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "output") appendOutput(msg.data);
        else if (msg.type === "system") appendOutput(msg.message + "\n", "ansi-cyan");
        else if (msg.type === "error") appendOutput(msg.message + "\n", "ansi-red");
      } catch {
        appendOutput(e.data);
      }
    };

    return () => ws.close();
  }, [agentId, appendOutput]);

  const handleKeyDown = useCallback((e) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;

    // Allow browser copy (Ctrl/Cmd+C without terminal Ctrl+C)
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && window.getSelection()?.toString()) return;
    // Allow browser paste — handled by onPaste
    if ((e.ctrlKey || e.metaKey) && e.key === "v") return;

    let data = "";
    if (e.key === "Enter") data = "\r";
    else if (e.key === "Backspace") data = "\x08";
    else if (e.key === "Tab") data = "\t";
    else if (e.key === "Escape") data = "\x1b";
    else if (e.key === "ArrowUp") data = "\x1b[A";
    else if (e.key === "ArrowDown") data = "\x1b[B";
    else if (e.key === "ArrowRight") data = "\x1b[C";
    else if (e.key === "ArrowLeft") data = "\x1b[D";
    else if (e.key === "Home") data = "\x1b[H";
    else if (e.key === "End") data = "\x1b[F";
    else if (e.key === "Delete") data = "\x1b[3~";
    else if (e.key === " ") data = " ";
    else if (e.ctrlKey && e.key === "c") data = "\x03";
    else if (e.ctrlKey && e.key === "d") data = "\x04";
    else if (e.ctrlKey && e.key === "z") data = "\x1a";
    else if (e.ctrlKey && e.key === "l") data = "\x0c";
    else if (e.ctrlKey && e.key === "a") data = "\x01";
    else if (e.ctrlKey && e.key === "e") data = "\x05";
    else if (e.ctrlKey && e.key === "u") data = "\x15";
    else if (e.ctrlKey && e.key === "k") data = "\x0b";
    else if (e.ctrlKey && e.key === "w") data = "\x17";
    else if (e.ctrlKey && e.key === "r") data = "\x12";
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) data = e.key;
    else return;

    e.preventDefault();
    e.stopPropagation();
    wsRef.current.send(JSON.stringify({ type: "input", data }));
  }, []);

  const handlePaste = useCallback((e) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text");
    if (text) {
      wsRef.current.send(JSON.stringify({ type: "input", data: text }));
    }
  }, []);

  const focusTerminal = useCallback(() => {
    outputRef.current?.focus();
  }, []);

  // Export terminal history as a text file
  const exportHistory = useCallback(() => {
    const text = lines.map(line => {
      const ts = line.ts ? `[${line.ts}] ` : "";
      const content = line.parts.map(p => p.text).join("");
      return ts + content;
    }).join("\n");

    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-${agentId}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines, agentId]);

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
          <span className="text-[10px] text-slate-600">{lines.length} lines</span>
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
              </>
            )}
          </div>
        </div>
      </div>

      {/* Terminal output — receives keyboard input directly via tabIndex */}
      <div
        ref={outputRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={focusTerminal}
        className="flex-1 overflow-y-auto cursor-text outline-none"
        style={{ height: `calc(100% - ${TOOLBAR_HEIGHT}px)`, backgroundColor: "#0a0e1a" }}
        autoFocus
      >
        <pre
          className="p-3 m-0 text-[13px] leading-[1.4] whitespace-pre-wrap break-all"
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
            color: "#e2e8f0",
            minHeight: "100%",
          }}
        >
          {lines.map((line, i) => (
            <div key={i}>
              {line.parts.map((part, j) => (
                part.className
                  ? <span key={j} className={part.className}>{part.text}</span>
                  : <span key={j}>{part.text}</span>
              ))}
            </div>
          ))}
        </pre>
      </div>

      <style jsx global>{`
        .ansi-black { color: #1e293b; }
        .ansi-red { color: #ef4444; }
        .ansi-green { color: #22c55e; }
        .ansi-yellow { color: #eab308; }
        .ansi-blue { color: #3b82f6; }
        .ansi-magenta { color: #a855f7; }
        .ansi-cyan { color: #06b6d4; }
        .ansi-white { color: #e2e8f0; }
        .ansi-bright-black { color: #475569; }
        .ansi-bright-red { color: #f87171; }
        .ansi-bright-green { color: #4ade80; }
        .ansi-bright-yellow { color: #facc15; }
        .ansi-bright-blue { color: #60a5fa; }
        .ansi-bright-magenta { color: #c084fc; }
        .ansi-bright-cyan { color: #22d3ee; }
        .ansi-bright-white { color: #f8fafc; }
        .ansi-bold { font-weight: bold; }
      `}</style>
    </div>
  );
}
