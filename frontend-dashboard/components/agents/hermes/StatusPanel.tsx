import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Key,
  Loader2,
  RefreshCw,
  Server,
  Workflow,
} from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";
import { useToast } from "../../Toast";
import {
  formatModelLabel,
  getProviderMeta,
  ProviderLogo,
} from "../providerLogos";

function formatTimestamp(value) {
  if (!value) return "Not reported";

  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function renderStateTone(ready) {
  return ready
    ? "bg-emerald-50 text-emerald-700"
    : "bg-amber-50 text-amber-700";
}

function formatProviderLabel(providerId, providerName, baseUrl = "") {
  const id = String(providerId || "").trim();
  if (!id) return "Unavailable";
  if (id === "custom" && baseUrl) {
    return `Custom (${baseUrl.replace(/^https?:\/\//, "")})`;
  }
  return getProviderMeta(id, providerName || id).name;
}

function buildChoiceKey(providerId, modelId) {
  return `${String(providerId || "").trim()}::${String(modelId || "").trim()}`;
}

function buildModelChoices(savedProviders, availableProviders) {
  const providerRows = Array.isArray(savedProviders) ? savedProviders : [];
  const catalogs = Array.isArray(availableProviders) ? availableProviders : [];
  const catalogById = new Map(
    catalogs.map((provider) => [provider.id, provider])
  );
  const groups = [];
  const options = [];
  const unavailableProviders = [];
  const rowsByProvider = new Map();

  for (const row of providerRows) {
    const providerId = String(row?.provider || "").trim();
    if (!providerId) continue;
    const existing = rowsByProvider.get(providerId) || [];
    existing.push(row);
    rowsByProvider.set(providerId, existing);
  }

  for (const [providerId, rows] of rowsByProvider.entries()) {
    const providerCatalog = catalogById.get(providerId) || null;
    const providerName =
      providerCatalog?.name || getProviderMeta(providerId, providerId).name;
    const normalizedRows = [...rows].sort(
      (left, right) => Number(Boolean(right?.is_default)) - Number(Boolean(left?.is_default))
    );
    const anchorRow = normalizedRows[0] || null;
    const seenModels = new Set();
    const groupOptions = [];

    function pushOption(modelId, rowId = anchorRow?.id || null) {
      const trimmedModel = String(modelId || "").trim();
      if (!trimmedModel || seenModels.has(trimmedModel)) return;
      seenModels.add(trimmedModel);

      const option = {
        key: buildChoiceKey(providerId, trimmedModel),
        providerId,
        providerName,
        modelId: trimmedModel,
        rowId,
      };
      groupOptions.push(option);
      options.push(option);
    }

    for (const row of normalizedRows) {
      pushOption(row?.model, row?.id || anchorRow?.id || null);
    }
    for (const modelId of providerCatalog?.models || []) {
      pushOption(modelId, anchorRow?.id || null);
    }

    if (groupOptions.length > 0) {
      groups.push({
        providerId,
        providerName,
        options: groupOptions,
      });
      continue;
    }

    unavailableProviders.push({
      providerId,
      providerName,
    });
  }

  return {
    groups,
    options,
    unavailableProviders,
  };
}

function resolveDefaultChoiceKey(savedProviders, options) {
  const providerRows = Array.isArray(savedProviders) ? savedProviders : [];
  const defaultRow =
    providerRows.find((provider) => provider?.is_default) || providerRows[0] || null;

  if (!defaultRow) {
    return options[0]?.key || "";
  }

  const exactMatch = options.find(
    (option) =>
      option.providerId === defaultRow.provider &&
      option.modelId === String(defaultRow.model || "").trim()
  );
  if (exactMatch) return exactMatch.key;

  const providerMatch = options.find(
    (option) => option.providerId === defaultRow.provider
  );
  return providerMatch?.key || options[0]?.key || "";
}

export default function HermesStatusPanel({
  agentId,
  runtimeInfo,
  loading,
  error,
  onRefresh,
}) {
  const [providers, setProviders] = useState(null);
  const [availableProviders, setAvailableProviders] = useState([]);
  const [selectedChoiceKey, setSelectedChoiceKey] = useState("");
  const [syncingKeys, setSyncingKeys] = useState(false);
  const [changingModel, setChangingModel] = useState(false);
  const toast = useToast();

  async function loadProviderChoices() {
    try {
      const [savedResponse, catalogResponse] = await Promise.all([
        fetchWithAuth("/api/llm-providers"),
        fetchWithAuth("/api/llm-providers/available"),
      ]);
      const [savedData, catalogData] = await Promise.all([
        savedResponse.json().catch(() => []),
        catalogResponse.json().catch(() => []),
      ]);

      setProviders(Array.isArray(savedData) ? savedData : []);
      setAvailableProviders(Array.isArray(catalogData) ? catalogData : []);
    } catch {
      setProviders([]);
      setAvailableProviders([]);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [savedResponse, catalogResponse] = await Promise.all([
          fetchWithAuth("/api/llm-providers"),
          fetchWithAuth("/api/llm-providers/available"),
        ]);
        const [savedData, catalogData] = await Promise.all([
          savedResponse.json().catch(() => []),
          catalogResponse.json().catch(() => []),
        ]);
        if (cancelled) return;
        setProviders(Array.isArray(savedData) ? savedData : []);
        setAvailableProviders(Array.isArray(catalogData) ? catalogData : []);
      } catch {
        if (cancelled) return;
        setProviders([]);
        setAvailableProviders([]);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    const nextChoices = buildModelChoices(providers, availableProviders);
    if (!nextChoices.options.length) {
      setSelectedChoiceKey("");
      return;
    }

    const preferredChoiceKey = resolveDefaultChoiceKey(
      providers,
      nextChoices.options
    );

    setSelectedChoiceKey((current) => {
      if (
        current &&
        nextChoices.options.some((option) => option.key === current)
      ) {
        return current;
      }
      return preferredChoiceKey;
    });
  }, [providers, availableProviders]);

  const runtimeReady = Boolean(runtimeInfo?.health?.ok);
  const models = Array.isArray(runtimeInfo?.models) ? runtimeInfo.models : [];
  const gateway: any = runtimeInfo?.gateway || {};
  const platformStates =
    gateway?.platformStates && typeof gateway.platformStates === "object"
      ? (Object.entries(gateway.platformStates) as [string, any][])
      : [];
  const modelChoices = buildModelChoices(providers, availableProviders);
  const savedDefaultProvider =
    Array.isArray(providers) && providers.length > 0
      ? providers.find((provider) => provider?.is_default) || providers[0]
      : null;
  const selectedChoice =
    modelChoices.options.find((option) => option.key === selectedChoiceKey) ||
    null;
  const currentProviderLabel = savedDefaultProvider
    ? formatProviderLabel(
        savedDefaultProvider.provider,
        savedDefaultProvider.provider,
        runtimeInfo?.configuredBaseUrl || ""
      )
    : formatProviderLabel(
        runtimeInfo?.configuredProvider,
        runtimeInfo?.configuredProvider,
        runtimeInfo?.configuredBaseUrl || ""
      );
  const currentModelLabel =
    runtimeInfo?.configuredModel ||
    savedDefaultProvider?.model ||
    runtimeInfo?.defaultModel ||
    "Unavailable";
  const defaultSelectionKey = savedDefaultProvider
    ? buildChoiceKey(savedDefaultProvider.provider, savedDefaultProvider.model)
    : "";
  const selectionDirty = Boolean(selectedChoice) && selectedChoice.key !== defaultSelectionKey;
  const hasProviders = Array.isArray(providers) && providers.length > 0;
  const summaryItems = [
    {
      label: "Runtime State",
      value: runtimeReady ? "Ready" : "Starting",
    },
    {
      label: "Configured Provider",
      value: currentProviderLabel,
    },
    {
      label: "Configured Model",
      value: currentModelLabel,
    },
    {
      label: "Published Models",
      value: String(models.length),
    },
    {
      label: "Gateway State",
      value: gateway?.state || "Unknown",
    },
    {
      label: "Active Agents",
      value: String(gateway?.activeAgents ?? 0),
    },
    {
      label: "Configured Platforms",
      value:
        gateway?.configuredPlatformsCount != null
          ? String(gateway.configuredPlatformsCount)
          : "Unknown",
    },
    {
      label: "Discovered Targets",
      value:
        gateway?.discoveredTargetsCount != null
          ? String(gateway.discoveredTargetsCount)
          : "Unknown",
    },
    {
      label: "Cron Jobs",
      value: gateway?.jobsCount != null ? String(gateway.jobsCount) : "Unknown",
    },
  ];

  async function handleSyncKeys() {
    setSyncingKeys(true);
    try {
      const res = await fetchWithAuth("/api/llm-providers/sync", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to sync Hermes LLM settings");
      }

      const agentResult = Array.isArray(data.results)
        ? data.results.find((entry) => entry.agentId === agentId)
        : null;
      if (agentResult && agentResult.status !== "synced") {
        throw new Error(agentResult.error || "Hermes sync failed");
      }
      if ((data.synced || 0) < 1) {
        throw new Error("Sync completed but Hermes was not updated");
      }

      toast.success("Hermes LLM settings synced");
      window.setTimeout(() => {
        onRefresh?.();
      }, 3000);
    } catch (nextError) {
      toast.error(nextError.message || "Failed to sync Hermes LLM settings");
    } finally {
      setSyncingKeys(false);
    }
  }

  async function handleApplySelection() {
    if (!selectedChoice?.rowId) {
      toast.error("Select a saved provider/model before syncing Hermes");
      return;
    }

    setChangingModel(true);
    try {
      const updateResponse = await fetchWithAuth(
        `/api/llm-providers/${selectedChoice.rowId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            model: selectedChoice.modelId,
            is_default: true,
          }),
        }
      );
      const updateData = await updateResponse.json().catch(() => ({}));
      if (!updateResponse.ok) {
        throw new Error(updateData.error || "Failed to save provider selection");
      }

      const syncResponse = await fetchWithAuth("/api/llm-providers/sync", {
        method: "POST",
        body: JSON.stringify({ agentId }),
      });
      const syncData = await syncResponse.json().catch(() => ({}));
      if (!syncResponse.ok) {
        throw new Error(syncData.error || "Failed to sync Hermes");
      }

      const agentResult = Array.isArray(syncData.results)
        ? syncData.results.find((entry) => entry.agentId === agentId)
        : null;
      if (agentResult && agentResult.status !== "synced") {
        throw new Error(agentResult.error || "Hermes sync failed");
      }

      await loadProviderChoices();
      toast.success(
        `Hermes now uses ${selectedChoice.providerName} / ${formatModelLabel(
          selectedChoice.modelId
        )}`
      );
      window.setTimeout(() => {
        onRefresh?.();
      }, 3000);
    } catch (nextError) {
      toast.error(nextError.message || "Failed to update Hermes model");
    } finally {
      setChangingModel(false);
    }
  }

  if (loading && !runtimeInfo) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (!runtimeInfo) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-bold text-amber-800">
              Hermes runtime details unavailable
            </p>
            <p className="mt-1 text-xs text-amber-700">
              {error || "The Hermes runtime has not reported status yet."}
            </p>
            <button
              onClick={onRefresh}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800 transition-colors hover:bg-amber-100"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
            Hermes Status
          </p>
          <p className="mt-1 text-sm font-bold text-slate-900">
            Runtime health, configured provider/model, and messaging gateway status in one place.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {runtimeInfo?.url || "Runtime URL unavailable"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${renderStateTone(
              runtimeReady
            )}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                runtimeReady ? "bg-emerald-500" : "animate-pulse bg-amber-500"
              }`}
            />
            {runtimeReady ? "Runtime Ready" : "Runtime Starting"}
          </span>
          <button
            onClick={handleSyncKeys}
            disabled={syncingKeys}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncingKeys ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Key size={12} />
            )}
            Sync LLM
          </button>
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="text-sm font-bold text-amber-800">Runtime check warning</p>
            <p className="mt-1 text-xs text-amber-700">{error}</p>
          </div>
        </div>
      ) : null}

      {runtimeInfo?.gatewayError ? (
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-slate-500" />
          <div>
            <p className="text-sm font-bold text-slate-800">
              Gateway snapshot unavailable
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {runtimeInfo.gatewayError}
            </p>
          </div>
        </div>
      ) : null}

      {runtimeInfo?.modelsError ? (
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-slate-500" />
          <div>
            <p className="text-sm font-bold text-slate-800">
              Model metadata warning
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {runtimeInfo.modelsError}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {summaryItems.map((item) => (
          <div
            key={item.label}
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              {item.label}
            </p>
            <p className="mt-2 text-sm font-bold text-slate-900">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-bold text-slate-900">Runtime API</p>
            <p className="mt-1 text-xs text-slate-500">
              Hermes exposes an OpenAI-compatible API surface for WebUI and direct requests.
            </p>
          </div>
          <div className="space-y-3 p-4">
            <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <Server size={16} className="mt-0.5 shrink-0 text-slate-500" />
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                  Runtime Endpoint
                </p>
                <p className="mt-1 break-all text-sm font-medium text-slate-800">
                  {runtimeInfo?.url || "Unavailable"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {runtimeInfo?.runtime?.host && runtimeInfo?.runtime?.port
                    ? `${runtimeInfo.runtime.host}:${runtimeInfo.runtime.port}`
                    : "Runtime host unavailable"}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <CheckCircle2
                size={16}
                className={`mt-0.5 shrink-0 ${
                  runtimeReady ? "text-emerald-500" : "text-amber-500"
                }`}
              />
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                  Health Check
                </p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {runtimeReady ? "Healthy" : "Waiting for readiness"}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {runtimeReady
                    ? "Hermes reported a healthy runtime response."
                    : runtimeInfo?.health?.error ||
                      "Hermes has not completed startup yet."}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50">
                  <ProviderLogo
                    providerId={savedDefaultProvider?.provider || runtimeInfo?.configuredProvider}
                    className="h-5 w-5"
                  />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">Primary LLM</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Pick a saved Nora provider/model to make it the default selection and push it
                    into Hermes.
                  </p>
                </div>
              </div>

              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                  Current Selection
                </p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {currentProviderLabel}
                </p>
                <p className="mt-1 break-all text-xs font-mono text-slate-600">
                  {currentModelLabel}
                </p>
                {runtimeInfo?.configuredBaseUrl ? (
                  <p className="mt-1 break-all text-xs text-slate-500">
                    Endpoint: {runtimeInfo.configuredBaseUrl}
                  </p>
                ) : null}
              </div>

              {!hasProviders ? (
                <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-sm font-bold text-amber-800">
                    No saved LLM provider available
                  </p>
                  <p className="mt-1 text-xs text-amber-700">
                    Add a provider in Settings before changing the Hermes default model.
                  </p>
                  <a
                    href="/settings"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-amber-700"
                  >
                    <Key size={12} />
                    Open Settings
                  </a>
                </div>
              ) : modelChoices.options.length > 0 ? (
                <>
                  <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <select
                      value={selectedChoiceKey}
                      onChange={(event) => setSelectedChoiceKey(event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    >
                      {modelChoices.groups.map((group) => (
                        <optgroup key={group.providerId} label={group.providerName}>
                          {group.options.map((option) => (
                            <option key={option.key} value={option.key}>
                              {group.providerName} / {formatModelLabel(option.modelId)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <button
                      onClick={handleApplySelection}
                      disabled={!selectionDirty || changingModel}
                      className="inline-flex items-center justify-center gap-1.5 rounded-2xl bg-blue-600 px-4 py-3 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {changingModel ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <CheckCircle2 size={12} />
                      )}
                      Apply to Hermes
                    </button>
                  </div>
                  {modelChoices.unavailableProviders.length > 0 ? (
                    <p className="mt-2 text-xs text-amber-600">
                      Saved providers without a model yet:{" "}
                      {modelChoices.unavailableProviders
                        .map((provider) => provider.providerName)
                        .join(", ")}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center">
                  <p className="text-sm font-medium text-slate-600">
                    Nora has saved providers, but none include a model Hermes can select yet.
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Save a model on the provider record in Settings, then return here to sync it.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-900">Published Models</p>
                  <p className="mt-1 text-xs text-slate-500">
                    The current runtime advertises these OpenAI-compatible model ids.
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                  {models.length}
                </span>
              </div>
              {models.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {models.map((model) => (
                    <span
                      key={model.id}
                      className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700"
                    >
                      {model.id}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  No models reported yet. Hermes may still be starting or waiting for upstream
                  auth.
                </p>
              )}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Messaging Gateway</p>
              <p className="mt-1 text-xs text-slate-500">
                Hermes runtime snapshot for cron and communication channels.
              </p>
            </div>
            <div className="space-y-3 p-4">
              <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <Workflow size={16} className="mt-0.5 shrink-0 text-slate-500" />
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">
                    Last Update
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-800">
                    {formatTimestamp(gateway?.updatedAt || runtimeInfo?.directoryUpdatedAt)}
                  </p>
                </div>
              </div>

              {gateway?.exitReason ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-700">
                    Exit Reason
                  </p>
                  <p className="mt-1 text-sm text-amber-800">{gateway.exitReason}</p>
                </div>
              ) : null}

              {gateway?.restartRequested ? (
                <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-700">
                    Pending Restart
                  </p>
                  <p className="mt-1 text-sm text-sky-800">
                    Hermes requested a runtime restart while applying recent configuration.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">Platform States</p>
              <p className="mt-1 text-xs text-slate-500">
                Per-platform health as reported by Hermes.
              </p>
            </div>
            <div className="p-4">
              {platformStates.length > 0 ? (
                <div className="space-y-2">
                  {platformStates.map(([platform, state]) => (
                    <div
                      key={platform}
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                          {platform}
                        </span>
                        <span className="text-xs font-medium text-slate-700">
                          {state?.state || "unknown"}
                        </span>
                      </div>
                      {state?.error_message ? (
                        <p className="mt-1 text-xs text-rose-600">
                          {state.error_message}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-center">
                  <Bot size={20} className="mx-auto text-slate-300" />
                  <p className="mt-2 text-sm font-medium text-slate-500">
                    No platform states reported yet
                  </p>
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
