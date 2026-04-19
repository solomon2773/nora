import { useState, useEffect } from "react";
import { fetchWithAuth } from "../../../lib/api";
import { Clock, Trash2, Plus, RefreshCw, Loader2, MessageSquare } from "lucide-react";

export default function SessionsPanel({ agentId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [selectedSession, setSelectedSession] = useState(null);

  async function fetchSessions() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/sessions`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : data.sessions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchSessions();
  }, [agentId]);

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Session ${sessions.length + 1}` }),
      });
      if (res.ok) {
        await fetchSessions();
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(sessionKey) {
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/sessions/${encodeURIComponent(sessionKey)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => (s.key || s.id) !== sessionKey));
        if ((selectedSession?.key || selectedSession?.id) === sessionKey) setSelectedSession(null);
      }
    } catch {
      // ignore
    }
  }

  async function handleViewSession(session) {
    const key = session.key || session.id;
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/sessions/${encodeURIComponent(key)}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedSession({ ...data, key });
      }
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-blue-500" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
          <Clock size={14} />
          Sessions
          <span className="text-xs font-normal text-slate-400">({sessions.length})</span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchSessions}
            className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 transition-colors"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 flex items-center gap-1 font-bold transition-colors disabled:opacity-50"
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            New Session
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">
          {error}
        </div>
      )}

      {sessions.length === 0 && !error ? (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center">
          <Clock size={24} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-400">No sessions yet</p>
          <p className="text-xs text-slate-300 mt-1">
            Sessions are created when you chat with the agent
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const sessionKey = session.key || session.id || session.sessionId;
            return (
            <div
              key={sessionKey}
              className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between hover:border-blue-200 transition-colors cursor-pointer"
              onClick={() => handleViewSession(session)}
            >
              <div className="flex items-center gap-3">
                <MessageSquare size={14} className="text-slate-400" />
                <div>
                  <p className="text-sm font-bold text-slate-700">
                    {session.name || session.label || sessionKey?.slice(0, 24)}
                  </p>
                  <p className="text-[10px] text-slate-400 font-mono">{sessionKey}</p>
                  {(session.created_at || session.createdAt || session.ts) && (
                    <p className="text-[10px] text-slate-400">
                      {new Date(session.created_at || session.createdAt || session.ts).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(session.message_count ?? session.messageCount ?? session.turns) !== undefined && (
                  <span className="text-[10px] text-slate-400">
                    {session.message_count ?? session.messageCount ?? session.turns} msgs
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(sessionKey);
                  }}
                  className="text-slate-300 hover:text-red-500 transition-colors p-1"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {/* Session detail viewer */}
      {selectedSession && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-slate-600">
              Session: {selectedSession.name || selectedSession.label || selectedSession.key?.slice(0, 24)}
            </h4>
            <button
              onClick={() => setSelectedSession(null)}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              Close
            </button>
          </div>
          {selectedSession.messages?.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {selectedSession.messages.map((msg, i) => (
                <div key={i} className={`text-xs p-2 rounded-lg ${
                  msg.role === "user" ? "bg-blue-50 text-blue-800" :
                  msg.role === "assistant" ? "bg-slate-100 text-slate-700" :
                  "bg-amber-50 text-amber-700"
                }`}>
                  <span className="font-bold capitalize">{msg.role}: </span>
                  <span className="whitespace-pre-wrap">{typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No messages in this session</p>
          )}
        </div>
      )}
    </div>
  );
}
