import { useState, useEffect } from "react";
import { fetchWithAuth } from "../../../lib/api";
import { Wrench, RefreshCw, Loader2, ChevronDown, ChevronUp } from "lucide-react";

export default function ToolsPanel({ agentId }) {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedTool, setExpandedTool] = useState(null);

  async function fetchTools() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/gateway/tools`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      // tools.catalog may return {tools:[...]}, array, or {catalog:[...]}
      const list = Array.isArray(data) ? data : data.tools || data.catalog || data.items || [];
      setTools(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTools();
  }, [agentId]);

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
          <Wrench size={14} />
          Tools
          <span className="text-xs font-normal text-slate-400">({tools.length})</span>
        </h3>
        <button
          onClick={fetchTools}
          className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 transition-colors"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">
          {error}
        </div>
      )}

      {tools.length === 0 && !error ? (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-8 text-center">
          <Wrench size={24} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-400">No tools registered</p>
          <p className="text-xs text-slate-300 mt-1">
            Tools become available when configured in the agent&apos;s OpenClaw settings
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tools.map((tool, idx) => {
            const name = tool.function?.name || tool.name || `Tool ${idx + 1}`;
            const desc = tool.function?.description || tool.description || "";
            const params = tool.function?.parameters || tool.parameters || null;
            const noraMeta = tool.nora || null;
            const isExpanded = expandedTool === name;

            return (
              <div
                key={idx}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => setExpandedTool(isExpanded ? null : name)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-2 text-left">
                    <Wrench size={12} className="text-amber-500 shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-slate-700">{name}</p>
                      {desc && <p className="text-[10px] text-slate-400 mt-0.5">{desc}</p>}
                      {noraMeta && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">
                            Integration Manifest
                          </span>
                          {noraMeta.provider && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-600">
                              {noraMeta.provider}
                            </span>
                          )}
                          {noraMeta.executionState === "manifest_only" && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-blue-700">
                              Discovery Only
                            </span>
                          )}
                          {noraMeta.executionState === "runtime_skill" && (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">
                              Live Via Skill
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-slate-400" />
                  ) : (
                    <ChevronDown size={14} className="text-slate-400" />
                  )}
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100 p-4 space-y-3">
                    {/* Parameters schema */}
                    {params && (
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 mb-1">Parameters Schema</p>
                        <pre className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] text-slate-600 font-mono overflow-x-auto max-h-40">
                          {JSON.stringify(params, null, 2)}
                        </pre>
                      </div>
                    )}
                    {noraMeta?.api && (
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 mb-1">Provider API</p>
                        <pre className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] text-slate-600 font-mono overflow-x-auto max-h-40">
                          {JSON.stringify(noraMeta.api, null, 2)}
                        </pre>
                      </div>
                    )}
                    {noraMeta?.mcp && (
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 mb-1">MCP</p>
                        <pre className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] text-slate-600 font-mono overflow-x-auto max-h-40">
                          {JSON.stringify(noraMeta.mcp, null, 2)}
                        </pre>
                      </div>
                    )}
                    {Array.isArray(noraMeta?.usageHints) && noraMeta.usageHints.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 mb-1">Usage Hints</p>
                        <ul className="space-y-1 text-[10px] text-slate-500">
                          {noraMeta.usageHints.map((hint, hintIndex) => (
                            <li key={`${name}-hint-${hintIndex}`}>- {hint}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {noraMeta?.invokeCommand && (
                      <div>
                        <p className="text-[10px] font-bold text-slate-500 mb-1">Agent Command</p>
                        <pre className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[10px] text-slate-600 font-mono overflow-x-auto max-h-40">
                          {noraMeta.invokeCommand}
                        </pre>
                      </div>
                    )}
                    <p className="text-[10px] text-slate-400">
                      {noraMeta?.executionState === "runtime_skill"
                        ? "This tool is connected through Nora and is executable inside the agent via the generated nora-integrations skill and local nora-integration-tool command."
                        : noraMeta?.executionState === "manifest_only"
                        ? "This tool comes from the Nora integration manifest. It advertises provider capability and schema, but the current runtime does not execute it yet."
                        : "Tools are invoked automatically by the AI model during chat conversations."}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
