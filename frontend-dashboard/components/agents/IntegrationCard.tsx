import { useState } from "react";
import {
  Puzzle,
  X,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Copy,
  Check,
  ExternalLink,
  Cpu,
} from "lucide-react";

type IntegrationCardProps = {
  item: any;
  installed?: any;
  onConnect?: (configValues?: Record<string, any>) => Promise<any> | any;
  onDisconnect?: () => Promise<void> | void;
  onTest?: (integration: any) => Promise<any> | any;
  directConnect?: boolean;
  submitLabel?: string;
};

// Computes the redirect URI an operator must register in the provider's
// OAuth app (e.g. LinkedIn developers console, X developer portal).
function computeOAuthRedirectUri(providerId: string): string {
  if (typeof window === "undefined" || !providerId) return "";
  return `${window.location.origin}/api/integrations/${providerId}/oauth/callback`;
}

export default function IntegrationCard({
  item,
  installed,
  onConnect,
  onDisconnect,
  onTest,
  directConnect = false,
  submitLabel = "Connect & Test",
}: IntegrationCardProps) {
  const [showConfig, setShowConfig] = useState(false);
  const [configValues, setConfigValues] = useState({});
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { success, message }
  const [redirectCopied, setRedirectCopied] = useState(false);

  const name = item.name || item.catalog_name || item.provider;
  const description = item.description || item.catalog_description || "";
  const category = item.category || item.catalog_category || "";
  const configFields = item.configFields || [];
  const isInstalled = !!installed;
  const isOAuth2 = item.authType === "oauth2";
  const redirectUri = isOAuth2 ? computeOAuthRedirectUri(item.id || item.provider) : "";
  const usageHints = Array.isArray(item.usageHints) ? item.usageHints : [];
  const credentialsUrl: string = typeof item.credentialsUrl === "string" ? item.credentialsUrl : "";
  const setupSteps: string[] = Array.isArray(item.setupGuide?.steps) ? item.setupGuide.steps : [];
  const setupScopes: string[] = Array.isArray(item.setupGuide?.scopes)
    ? item.setupGuide.scopes
    : [];
  const mcpAvailable = item.mcp && item.mcp.available === true;

  async function copyRedirectUri() {
    if (!redirectUri || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setRedirectCopied(true);
      setTimeout(() => setRedirectCopied(false), 2000);
    } catch {
      // Clipboard API blocked (insecure context, permission denied) — silent.
    }
  }

  const categoryColors = {
    "developer-tools": "bg-blue-50 text-blue-700",
    communication: "bg-purple-50 text-purple-700",
    "ai-ml": "bg-emerald-50 text-emerald-700",
    cloud: "bg-orange-50 text-orange-700",
    data: "bg-yellow-50 text-yellow-700",
    monitoring: "bg-red-50 text-red-700",
    productivity: "bg-teal-50 text-teal-700",
    crm: "bg-indigo-50 text-indigo-700",
    storage: "bg-cyan-50 text-cyan-700",
    payment: "bg-green-50 text-green-700",
    social: "bg-pink-50 text-pink-700",
    analytics: "bg-violet-50 text-violet-700",
    search: "bg-amber-50 text-amber-700",
    devops: "bg-lime-50 text-lime-700",
    automation: "bg-fuchsia-50 text-fuchsia-700",
    ecommerce: "bg-rose-50 text-rose-700",
  };

  async function handleConnectClick() {
    if (directConnect) {
      setConnecting(true);
      setTestResult(null);
      try {
        await onConnect?.();
      } finally {
        setConnecting(false);
      }
      return;
    }

    if (configFields.length > 0) {
      setShowConfig(true);
      setTestResult(null);
    } else {
      onConnect?.();
    }
  }

  async function handleConfigSubmit() {
    setConnecting(true);
    setTestResult(null);
    try {
      const result = await onConnect?.(configValues);
      if (result?.testResult) {
        setTestResult(result.testResult);
      }
      if (result?.testResult?.success) {
        setTimeout(() => {
          setShowConfig(false);
          setConfigValues({});
        }, 1500);
      }
    } catch {
      setTestResult({ success: false, message: "Connection failed" });
    } finally {
      setConnecting(false);
    }
  }

  async function handleTest() {
    if (!installed || !onTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(installed);
      setTestResult(result);
    } catch {
      setTestResult({ success: false, message: "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center">
              <Puzzle size={18} className="text-slate-600" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-slate-900">{name}</h4>
              <div className="flex items-center gap-1 flex-wrap mt-0.5">
                {category && (
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${categoryColors[category] || "bg-slate-50 text-slate-500"}`}
                  >
                    {category.replace(/-/g, " ")}
                  </span>
                )}
                {mcpAvailable && (
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 inline-flex items-center gap-1"
                    title={item.mcp?.notes || "MCP server available for this provider"}
                  >
                    <Cpu size={10} />
                    MCP
                  </span>
                )}
              </div>
            </div>
          </div>
          {isInstalled ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleTest}
                disabled={testing}
                className="text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50"
                title="Test connection"
              >
                {testing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              </button>
              <button
                onClick={onDisconnect}
                className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={handleConnectClick}
              disabled={connecting}
              className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              {connecting ? <Loader2 size={11} className="animate-spin" /> : "Connect"}
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{description}</p>
        {item.capabilities && (
          <div className="flex gap-1 mt-2">
            {item.capabilities.map((cap) => (
              <span
                key={cap}
                className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase"
              >
                {cap}
              </span>
            ))}
          </div>
        )}
        {/* Test result badge for installed integrations */}
        {isInstalled && testResult && (
          <div
            className={`flex items-center gap-1.5 mt-2 px-2 py-1 rounded-lg text-[10px] font-medium ${testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}
          >
            {testResult.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
            {testResult.message}
          </div>
        )}
      </div>

      {/* Config Modal */}
      {showConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Configure {name}</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  Fill in the required fields to connect
                </p>
              </div>
              <button
                onClick={() => {
                  setShowConfig(false);
                  setConfigValues({});
                  setTestResult(null);
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {(credentialsUrl || setupSteps.length > 0 || setupScopes.length > 0) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
                    Where to apply for credentials
                  </div>
                  {credentialsUrl && (
                    <a
                      href={credentialsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:text-blue-800 hover:underline break-all"
                    >
                      <ExternalLink size={11} />
                      {credentialsUrl}
                    </a>
                  )}
                  {setupSteps.length > 0 && (
                    <ol className="list-decimal pl-4 text-[11px] leading-relaxed text-slate-700 space-y-0.5">
                      {setupSteps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ol>
                  )}
                  {setupScopes.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-slate-500 font-semibold">
                        Required scopes:
                      </span>
                      {setupScopes.map((scope) => (
                        <span
                          key={scope}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {item.mcp && item.mcp.available === true && (
                <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-1">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-violet-700 inline-flex items-center gap-1">
                    <Cpu size={11} />
                    MCP server available
                  </div>
                  {item.mcp.notes && (
                    <p className="text-[11px] leading-relaxed text-violet-900">{item.mcp.notes}</p>
                  )}
                  {(item.mcp.npmPackage || item.mcp.pyPackage || item.mcp.serverUrl) && (
                    <code className="block break-all rounded border border-violet-200 bg-white px-2 py-1 font-mono text-[11px] text-slate-700">
                      {item.mcp.npmPackage || item.mcp.pyPackage || item.mcp.serverUrl}
                    </code>
                  )}
                  {item.mcp.docsUrl && (
                    <a
                      href={item.mcp.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline"
                    >
                      <ExternalLink size={10} />
                      MCP docs
                    </a>
                  )}
                </div>
              )}
              {isOAuth2 && redirectUri && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-2">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-blue-700">
                    OAuth Redirect URI
                  </div>
                  <p className="text-[11px] leading-relaxed text-blue-800">
                    Add this exact URL as an authorized redirect URI in your {name} OAuth app before
                    clicking <span className="font-semibold">{submitLabel || "Authorize"}</span>.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded border border-blue-200 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-700">
                      {redirectUri}
                    </code>
                    <button
                      type="button"
                      onClick={copyRedirectUri}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-blue-700"
                      title="Copy redirect URI"
                    >
                      {redirectCopied ? (
                        <>
                          <Check size={11} />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy size={11} />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                  {usageHints.length > 0 && (
                    <ul className="list-disc pl-4 text-[11px] leading-relaxed text-blue-800/80 space-y-0.5">
                      {usageHints.slice(0, 2).map((hint, idx) => (
                        <li key={idx}>{hint}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {configFields.map((field) => (
                <div key={field.key}>
                  <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest block mb-1">
                    {field.label} {field.required && <span className="text-red-400">*</span>}
                  </label>
                  {field.type === "textarea" ? (
                    <textarea
                      value={configValues[field.key] || ""}
                      onChange={(e) =>
                        setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      rows={4}
                      placeholder={field.placeholder || ""}
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                  ) : (
                    <input
                      type={field.type === "password" ? "password" : "text"}
                      value={configValues[field.key] || ""}
                      onChange={(e) =>
                        setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      placeholder={field.placeholder || (field.type === "url" ? "https://..." : "")}
                      className="w-full text-xs border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                </div>
              ))}
            </div>
            {/* Test result banner in modal */}
            {testResult && (
              <div
                className={`mx-4 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${testResult.success ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}
              >
                {testResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                {testResult.message}
              </div>
            )}
            <div className="flex gap-2 justify-end p-4 border-t border-slate-100">
              <button
                onClick={() => {
                  setShowConfig(false);
                  setConfigValues({});
                  setTestResult(null);
                }}
                className="px-4 py-2 text-[10px] font-bold text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleConfigSubmit}
                disabled={connecting}
                className="flex items-center gap-2 px-4 py-2 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {connecting && <Loader2 size={12} className="animate-spin" />}
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
