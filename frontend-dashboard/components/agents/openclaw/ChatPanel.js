import { useState, useRef, useEffect, useCallback } from "react";
import { fetchWithAuth } from "../../../lib/api";
import {
  Send, Loader2, Bot, User, Wrench, Brain, Trash2, StopCircle, AlertTriangle,
} from "lucide-react";
import LLMSetupWizard from "../LLMSetupWizard";

/** Strip protocol wrapper tags and gateway metadata from display text. */
function stripProtocolTags(text) {
  if (!text) return text;
  return text
    .replace(/<\/?final>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?thinking>/gi, "")
    .replace(/<\/?reasoning>/gi, "")
    .replace(/<\/?artifact[^>]*>/gi, "")
    // Strip "Sender (untrusted metadata): ..." blocks injected by the gateway
    .replace(/Sender \(untrusted metadata\):[\s\S]*?(?=\n\n|\[|$)/gi, "")
    .trim();
}

/**
 * Full interactive chat panel with streaming, tool visualization, and thinking traces.
 * Uses the OpenAI-compatible /v1/chat/completions endpoint via our gateway proxy.
 */
const MESSAGES_PER_PAGE = 30;

export default function ChatPanel({ agentId }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [hasProviders, setHasProviders] = useState(null); // null=loading, true/false
  const [showSetup, setShowSetup] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [allHistory, setAllHistory] = useState([]); // full history from gateway
  const [displayOffset, setDisplayOffset] = useState(0); // how many older messages are loaded
  const scrollRef = useRef(null);
  const abortRef = useRef(null);
  const prevScrollHeightRef = useRef(0);

  // Check if user has LLM providers configured
  useEffect(() => {
    fetchWithAuth("/api/llm-providers")
      .then((r) => r.json())
      .then((data) => {
        const has = Array.isArray(data) && data.length > 0;
        setHasProviders(has);
        if (!has) setShowSetup(true);
      })
      .catch(() => setHasProviders(false));
  }, []);

  // Load chat history from gateway session
  useEffect(() => {
    if (!agentId) return;
    setLoadingHistory(true);

    // First get sessions, then load the most recent session's history
    fetchWithAuth(`/api/agents/${agentId}/gateway/sessions`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        const sessions = Array.isArray(data) ? data : data.sessions || [];
        if (sessions.length === 0) return;

        // Pick the most recent session (or "main")
        const main = sessions.find(s => s.key === "main") || sessions[0];
        const key = main.key || main.id || "main";
        setSessionId(key);
        return fetchWithAuth(`/api/agents/${agentId}/gateway/sessions/${key}`);
      })
      .then((r) => r?.ok ? r.json() : null)
      .then((session) => {
        if (!session) return;
        // Extract messages from session history
        const history = session.messages || session.history || session.conversation || [];
        if (!Array.isArray(history) || history.length === 0) return;

        // Extract text from content — handles string, array of {type,text}, or object
        function extractContent(content) {
          if (!content) return "";
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .map(c => (typeof c === "string" ? c : c.text || c.content || ""))
              .join("");
          }
          if (typeof content === "object") return content.text || content.content || JSON.stringify(content);
          return String(content);
        }

        // Convert to our message format, stripping protocol tags from stored history
        const formatted = history.map((msg, i) => ({
          role: msg.role || (msg.type === "human" ? "user" : "assistant"),
          content: stripProtocolTags(extractContent(msg.content) || extractContent(msg.text) || extractContent(msg.message) || ""),
          ts: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now() - (history.length - i) * 1000,
          streaming: false,
          toolCalls: msg.tool_calls || [],
          thinking: extractContent(msg.thinking) || extractContent(msg.reasoning) || "",
        })).filter(m => m.content); // skip empty messages

        setAllHistory(formatted);

        // Show the most recent page
        const recentStart = Math.max(0, formatted.length - MESSAGES_PER_PAGE);
        setMessages(formatted.slice(recentStart));
        setDisplayOffset(recentStart);
        setHasMoreHistory(recentStart > 0);
      })
      .catch(() => {}) // gateway might not support session history
      .finally(() => setLoadingHistory(false));
  }, [agentId]);

  // Auto-scroll to bottom on new messages (only if already near bottom)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Infinite scroll — load older messages when scrolling to top
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMoreHistory || loadingHistory) return;
    if (el.scrollTop < 80) {
      // Load more older messages
      const newOffset = Math.max(0, displayOffset - MESSAGES_PER_PAGE);
      const olderMessages = allHistory.slice(newOffset, displayOffset);
      if (olderMessages.length === 0) return;

      prevScrollHeightRef.current = el.scrollHeight;
      setMessages(prev => [...olderMessages, ...prev]);
      setDisplayOffset(newOffset);
      setHasMoreHistory(newOffset > 0);

      // Preserve scroll position after prepending
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      });
    }
  }, [hasMoreHistory, loadingHistory, displayOffset, allHistory]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg = { role: "user", content: text, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setAllHistory((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    // Create an assistant placeholder for streaming
    const assistantId = Date.now();
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", ts: assistantId, streaming: true, toolCalls: [], thinking: "" },
    ]);

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      // Send single message string — OpenClaw gateway uses sessionKey for context,
      // not an OpenAI-style messages array
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          stream: true,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Chat request failed" }));
        setMessages((prev) =>
          prev.map((m) =>
            m.ts === assistantId
              ? { ...m, content: `Error: ${err.error || err.details || "Unknown error"}`, streaming: false }
              : m
          )
        );
        setSending(false);
        return;
      }

      // Stream SSE response
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);

            // Handle final done marker from proxy
            if (chunk.type === "done") {
              // Capture session key from response if available
              const sid = chunk.result?.sessionKey || chunk.result?.session_id || chunk.sessionKey;
              if (sid) setSessionId(sid);
              continue;
            }
            // Handle error from proxy
            if (chunk.type === "error") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.ts === assistantId
                    ? { ...m, content: m.content || `Error: ${chunk.error}`, streaming: false }
                    : m
                )
              );
              continue;
            }

            // Gateway chat/agent events carry content in various shapes
            // Try OpenAI-compat delta first, then raw payload text
            const delta = chunk.choices?.[0]?.delta;
            let rawText = delta?.content || chunk.text || chunk.content || chunk.message || "";
            const toolCalls = delta?.tool_calls || chunk.tool_calls;
            const thinking = delta?.reasoning || delta?.thinking || chunk.thinking || "";

            // Strip XML wrapper tags the gateway may emit (<final>, <thinking>, etc.)
            // These are protocol artifacts — the user should see clean content only.
            rawText = rawText
              .replace(/<\/?final>/gi, "")
              .replace(/<\/?thinking>/gi, "")
              .replace(/<\/?reasoning>/gi, "")
              .replace(/<\/?artifact[^>]*>/gi, "");
            const text = rawText;

            setMessages((prev) =>
              prev.map((m) => {
                if (m.ts !== assistantId) return m;
                const updated = { ...m };

                if (text) {
                  updated.content += text;
                }

                if (toolCalls) {
                  const newToolCalls = [...(updated.toolCalls || [])];
                  for (const tc of toolCalls) {
                    const idx = tc.index !== undefined ? tc.index : newToolCalls.length;
                    if (!newToolCalls[idx]) {
                      newToolCalls[idx] = {
                        id: tc.id || "",
                        type: tc.type || "function",
                        function: { name: "", arguments: "" },
                      };
                    }
                    if (tc.function?.name) newToolCalls[idx].function.name += tc.function.name;
                    if (tc.function?.arguments) newToolCalls[idx].function.arguments += tc.function.arguments;
                  }
                  updated.toolCalls = newToolCalls;
                }

                if (thinking) {
                  updated.thinking = (updated.thinking || "") + thinking;
                }

                return updated;
              })
            );
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      // Mark streaming complete
      setMessages((prev) =>
        prev.map((m) => (m.ts === assistantId ? { ...m, streaming: false } : m))
      );
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.ts === assistantId
              ? { ...m, content: `Error: ${err.message}`, streaming: false }
              : m
          )
        );
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [input, sending, messages, agentId, sessionId]);

  function handleStop() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  function handleClear() {
    setMessages([]);
    setAllHistory([]);
    setDisplayOffset(0);
    setHasMoreHistory(false);
    setSessionId(null);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Show setup wizard if no providers
  if (showSetup && hasProviders === false) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-6 w-full" style={{ minHeight: "350px" }}>
        <LLMSetupWizard onComplete={() => { setShowSetup(false); setHasProviders(true); }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-white border border-slate-200 rounded-2xl overflow-hidden w-full" style={{ height: "calc(100vh - 20rem)", minHeight: "350px", maxHeight: "calc(100vh - 12rem)" }}>
      {/* No-provider banner */}
      {hasProviders === false && !showSetup && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700">
          <AlertTriangle size={12} />
          <span>No LLM provider configured.</span>
          <button onClick={() => setShowSetup(true)} className="font-bold text-amber-800 underline hover:text-amber-900">Set up now</button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
          <Bot size={14} />
          Chat
          {sessionId && (
            <span className="text-[10px] font-mono text-slate-400 ml-2">
              session: {sessionId.slice(0, 8)}
            </span>
          )}
        </div>
        <button
          onClick={handleClear}
          className="text-xs text-slate-400 hover:text-red-500 flex items-center gap-1 transition-colors"
        >
          <Trash2 size={11} />
          Clear
        </button>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {hasMoreHistory && (
          <div className="flex justify-center py-2">
            <button
              onClick={() => handleScroll()}
              className="text-[10px] text-blue-500 hover:text-blue-700 font-bold flex items-center gap-1 transition-colors"
            >
              <Loader2 size={10} className={loadingHistory ? "animate-spin" : ""} />
              Load older messages
            </button>
          </div>
        )}
        {loadingHistory && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
            <Loader2 size={24} className="animate-spin text-blue-500" />
            <p className="text-xs font-medium">Loading chat history...</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-3">
            <Bot size={40} className="opacity-30" />
            <p className="text-sm font-medium">Send a message to start chatting with your agent</p>
            <p className="text-xs text-slate-300">
              Uses the OpenClaw Gateway&apos;s OpenAI-compatible API
            </p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble key={msg.ts || i} message={msg} />
          ))
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-slate-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 resize-none border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all"
            style={{ minHeight: "38px", maxHeight: "120px" }}
            onInput={(e) => {
              e.target.style.height = "38px";
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
            }}
          />
          {sending ? (
            <button
              onClick={handleStop}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              <StopCircle size={16} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Markdown-lite renderer ──────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let key = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block start/end
    if (line.startsWith("```")) {
      if (inCode) {
        elements.push(
          <div key={key++} className="my-2 rounded-lg overflow-hidden border border-slate-200">
            {codeLang && (
              <div className="px-3 py-1 bg-slate-700 text-[10px] text-slate-300 font-mono font-bold uppercase tracking-wider">
                {codeLang}
              </div>
            )}
            <pre className="p-3 bg-slate-800 text-slate-200 text-xs font-mono overflow-x-auto leading-relaxed">
              {codeLines.join("\n")}
            </pre>
          </div>
        );
        inCode = false;
        codeLines = [];
        codeLang = "";
      } else {
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Inline formatting
    const formatted = formatInline(line);

    // Headers
    if (line.startsWith("### ")) {
      elements.push(<p key={key++} className="font-bold text-slate-900 mt-2 mb-1">{formatInline(line.slice(4))}</p>);
    } else if (line.startsWith("## ")) {
      elements.push(<p key={key++} className="font-bold text-slate-900 text-base mt-3 mb-1">{formatInline(line.slice(3))}</p>);
    } else if (line.startsWith("# ")) {
      elements.push(<p key={key++} className="font-black text-slate-900 text-lg mt-3 mb-1">{formatInline(line.slice(2))}</p>);
    }
    // Bullet lists
    else if (/^[\-\*]\s/.test(line)) {
      elements.push(
        <div key={key++} className="flex gap-2 ml-1">
          <span className="text-blue-400 shrink-0 mt-0.5">•</span>
          <span>{formatInline(line.slice(2))}</span>
        </div>
      );
    }
    // Numbered lists
    else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)[1];
      elements.push(
        <div key={key++} className="flex gap-2 ml-1">
          <span className="text-blue-500 font-bold shrink-0 mt-0.5 text-xs w-4 text-right">{num}.</span>
          <span>{formatInline(line.replace(/^\d+\.\s/, ""))}</span>
        </div>
      );
    }
    // Blockquotes
    else if (line.startsWith("> ")) {
      elements.push(
        <div key={key++} className="border-l-2 border-blue-300 pl-3 text-slate-500 italic my-1">
          {formatInline(line.slice(2))}
        </div>
      );
    }
    // Empty line = paragraph break
    else if (line.trim() === "") {
      elements.push(<div key={key++} className="h-2" />);
    }
    // Normal text
    else {
      elements.push(<span key={key++}>{formatted}{"\n"}</span>);
    }
  }

  // Unclosed code block
  if (inCode && codeLines.length > 0) {
    elements.push(
      <div key={key++} className="my-2 rounded-lg overflow-hidden border border-slate-200">
        {codeLang && (
          <div className="px-3 py-1 bg-slate-700 text-[10px] text-slate-300 font-mono font-bold uppercase tracking-wider">
            {codeLang}
          </div>
        )}
        <pre className="p-3 bg-slate-800 text-slate-200 text-xs font-mono overflow-x-auto leading-relaxed">
          {codeLines.join("\n")}
        </pre>
      </div>
    );
  }

  return elements;
}

function formatInline(text) {
  if (!text) return text;
  // Split on inline code, bold, italic — return mixed text/JSX
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Inline code
    const codeMatch = remaining.match(/`([^`]+)`/);
    // Bold
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);

    let firstMatch = null;
    let firstIndex = remaining.length;

    if (codeMatch && codeMatch.index < firstIndex) {
      firstMatch = { type: "code", match: codeMatch };
      firstIndex = codeMatch.index;
    }
    if (boldMatch && boldMatch.index < firstIndex) {
      firstMatch = { type: "bold", match: boldMatch };
      firstIndex = boldMatch.index;
    }

    if (!firstMatch) {
      parts.push(remaining);
      break;
    }

    // Text before match
    if (firstIndex > 0) {
      parts.push(remaining.slice(0, firstIndex));
    }

    if (firstMatch.type === "code") {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded text-xs font-mono">
          {firstMatch.match[1]}
        </code>
      );
      remaining = remaining.slice(firstIndex + firstMatch.match[0].length);
    } else if (firstMatch.type === "bold") {
      parts.push(<strong key={key++} className="font-bold">{firstMatch.match[1]}</strong>);
      remaining = remaining.slice(firstIndex + firstMatch.match[0].length);
    }
  }

  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
}

// ─── Message Bubble Component ─────────────────────────────────────

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  const [showThinking, setShowThinking] = useState(false);
  const [showToolArgs, setShowToolArgs] = useState({});

  return (
    <div className={`flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center shadow-sm ${
          isUser
            ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white"
            : "bg-gradient-to-br from-slate-100 to-slate-200 text-slate-600"
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Content */}
      <div className={`flex-1 ${isUser ? "text-right" : ""} max-w-[85%] space-y-1.5`}>
        {/* Thinking trace */}
        {message.thinking && (
          <div className="mb-1">
            <button
              onClick={() => setShowThinking(!showThinking)}
              className="text-[10px] text-purple-500 hover:text-purple-700 flex items-center gap-1.5 font-bold transition-colors px-2 py-1 rounded-lg hover:bg-purple-50"
            >
              <Brain size={11} />
              {showThinking ? "Hide reasoning" : "Show reasoning"}
              {message.streaming && !showThinking && (
                <span className="w-1.5 h-1.5 bg-purple-400 rounded-full animate-pulse" />
              )}
            </button>
            {showThinking && (
              <div className="mt-1.5 p-3 bg-gradient-to-br from-purple-50 to-violet-50 border border-purple-100 rounded-xl text-xs text-purple-700 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto leading-relaxed">
                {message.thinking}
                {message.streaming && <span className="inline-block w-1.5 h-3.5 bg-purple-400 ml-0.5 animate-pulse rounded-sm" />}
              </div>
            )}
          </div>
        )}

        {/* Tool calls */}
        {message.toolCalls?.length > 0 && (
          <div className="mb-2 space-y-1.5">
            {message.toolCalls.map((tc, idx) => {
              const name = tc.function?.name || "tool";
              const args = tc.function?.arguments || "";
              const isExpanded = showToolArgs[idx];
              return (
                <div key={idx} className="text-left">
                  <button
                    onClick={() => setShowToolArgs(prev => ({ ...prev, [idx]: !prev[idx] }))}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl text-[11px] text-amber-700 font-mono hover:shadow-sm transition-all"
                  >
                    <Wrench size={11} className={message.streaming ? "animate-spin" : ""} />
                    <span className="font-bold">{name}</span>
                    {args && <span className="text-amber-400 text-[9px]">{isExpanded ? "▼" : "▶"}</span>}
                  </button>
                  {isExpanded && args && (
                    <pre className="mt-1 p-2 bg-slate-800 text-slate-200 text-[10px] font-mono rounded-lg overflow-x-auto max-h-32 overflow-y-auto">
                      {tryFormatJson(args)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Streaming "typing" indicator when no content yet */}
        {message.streaming && !message.content && !message.thinking && message.toolCalls?.length === 0 && (
          <div className="inline-flex items-center gap-1 px-3 py-2 bg-slate-100 rounded-xl">
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}

        {/* Message content */}
        {message.content && (
          <div
            className={`inline-block px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
              isUser
                ? "bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-sm shadow-blue-500/20"
                : "bg-slate-50 border border-slate-200 text-slate-800"
            }`}
          >
            {isUser ? (
              <span className="whitespace-pre-wrap">{message.content}</span>
            ) : (
              <div className="whitespace-pre-wrap">
                {renderMarkdown(message.content)}
                {message.streaming && (
                  <span className="inline-block w-1.5 h-4 bg-blue-500 ml-0.5 animate-pulse rounded-sm align-text-bottom" />
                )}
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        {!message.streaming && message.ts && (
          <p className={`text-[9px] text-slate-300 mt-0.5 ${isUser ? "text-right" : ""}`}>
            {new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
        )}
      </div>
    </div>
  );
}

function tryFormatJson(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
