import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";

function formatMessageTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function HermesChatPanel({
  agentId,
  runtimeInfo,
  loadingRuntime,
  runtimeError,
  onRefreshRuntime,
}) {
  const [sending, setSending] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const messageListRef = useRef(null);

  const runtimeReady = Boolean(runtimeInfo?.health?.ok);
  const defaultModel =
    runtimeInfo?.configuredModel ||
    runtimeInfo?.defaultModel ||
    runtimeInfo?.models?.[0]?.id ||
    null;

  useEffect(() => {
    if (!messageListRef.current) return;
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages, sending]);

  function resetConversation() {
    setMessages([]);
    setSessionId("");
    setError("");
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content || sending || !runtimeReady) return;

    const nextUserMessage = {
      id: `user-${Date.now().toString(36)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, nextUserMessage];

    setMessages(nextMessages);
    setDraft("");
    setSending(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/chat`, {
        method: "POST",
        body: JSON.stringify({
          ...(defaultModel ? { model: defaultModel } : {}),
          ...(sessionId ? { sessionId } : {}),
          messages: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Hermes chat request failed");
      }

      setSessionId(data.sessionId || "");
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now().toString(36)}`,
          role: "assistant",
          content: data.message || "(No response returned)",
          usage: data.usage || null,
          model: data.model || defaultModel || null,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (nextError) {
      setMessages((current) =>
        current.filter((message) => message.id !== nextUserMessage.id)
      );
      setDraft(content);
      setError(nextError.message || "Hermes chat request failed");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    handleSend();
  }

  if (loadingRuntime && !runtimeInfo) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
            Hermes Chat
          </p>
          <p className="mt-1 text-sm font-bold text-slate-900">
            Direct conversation against Hermes&apos;s OpenAI-compatible runtime API.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {defaultModel ? `Default model: ${defaultModel}` : "No model reported yet"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
              runtimeReady
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                runtimeReady ? "bg-emerald-500" : "animate-pulse bg-amber-500"
              }`}
            />
            {runtimeReady ? "Ready" : "Waiting"}
          </span>
          <button
            onClick={onRefreshRuntime}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
          >
            <RefreshCw size={12} className={loadingRuntime ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {runtimeError ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-bold text-amber-800">Runtime check warning</p>
            <p className="mt-1 text-xs text-amber-700">{runtimeError}</p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-bold text-rose-800">Chat request failed</p>
            <p className="mt-1 text-xs text-rose-700">{error}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" style={{ minHeight: "560px" }}>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-slate-900">Conversation</p>
              <p className="mt-1 text-xs text-slate-500">
                {runtimeReady
                  ? "Session-aware chat against the running Hermes API."
                  : runtimeInfo?.health?.error || "Waiting for Hermes to finish starting."}
              </p>
            </div>
            <button
              onClick={resetConversation}
              disabled={!messages.length && !sessionId}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={12} />
              Reset
            </button>
          </div>

          <div
            ref={messageListRef}
            className="flex-1 space-y-4 overflow-y-auto bg-slate-50/70 px-4 py-4"
          >
            {messages.length === 0 ? (
              <div className="flex h-full min-h-[280px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 text-center">
                <Bot size={26} className="text-slate-300" />
                <p className="mt-3 text-sm font-bold text-slate-700">
                  No active conversation yet
                </p>
                <p className="mt-1 max-w-sm text-xs text-slate-500">
                  Send a prompt once the Hermes runtime reports healthy status.
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const isAssistant = message.role === "assistant";
                return (
                  <div
                    key={message.id}
                    className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-2xl px-4 py-3 shadow-sm ${
                        isAssistant
                          ? "border border-slate-200 bg-white text-slate-800"
                          : "bg-blue-600 text-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className={`text-[10px] font-black uppercase tracking-[0.16em] ${
                            isAssistant ? "text-blue-600" : "text-blue-100"
                          }`}
                        >
                          {isAssistant ? "Hermes" : "You"}
                        </span>
                        <span
                          className={`text-[10px] ${
                            isAssistant ? "text-slate-400" : "text-blue-100"
                          }`}
                        >
                          {formatMessageTime(message.createdAt)}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                        {message.content}
                      </p>
                      {message.usage?.total_tokens ? (
                        <p
                          className={`mt-2 text-[10px] ${
                            isAssistant ? "text-slate-400" : "text-blue-100"
                          }`}
                        >
                          {message.model || "model"} · {message.usage.total_tokens} tokens
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
            {sending ? (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-500 shadow-sm">
                  <Loader2 size={12} className="animate-spin text-blue-500" />
                  Hermes is responding
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t border-slate-200 bg-white px-4 py-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={
                  runtimeReady
                    ? "Ask Hermes to inspect the workspace, summarize logs, or draft a response..."
                    : "Wait for the Hermes runtime to become ready before sending a prompt."
                }
                rows={4}
                disabled={!runtimeReady || sending}
                className="w-full resize-none bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-400"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {sessionId ? `Session ${sessionId}` : "New Hermes session"}
                </div>
                <button
                  onClick={handleSend}
                  disabled={!runtimeReady || sending || !draft.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Session</p>
              <p className="mt-1 text-xs text-slate-500">
                Request context for the current chat thread.
              </p>
            </div>
            <div className="space-y-3 p-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Runtime
                </p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {runtimeReady ? "Ready for chat" : "Unavailable"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Model
                </p>
                <p className="mt-1 break-all text-sm font-medium text-slate-800">
                  {defaultModel || "Not reported"}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Session Id
                </p>
                <p className="mt-1 break-all text-sm font-medium text-slate-800">
                  {sessionId || "Generated on first response"}
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Tips</p>
            </div>
            <div className="space-y-3 p-4 text-xs text-slate-600">
              <p>Use the Status tab first if Hermes is still starting or models are missing.</p>
              <p>Integration and channel changes can restart Hermes, so refresh this tab after edits.</p>
              <p>Conversation state is carried with the Hermes session id until you reset it.</p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
