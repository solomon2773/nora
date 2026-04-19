import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  SearchCheck,
  Trash2,
  X,
} from "lucide-react";
import { fetchWithAuth } from "../../../lib/api";
import { useToast } from "../../Toast";

function formatTimestamp(value) {
  if (!value) return null;

  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function homeChannelLabel(homeChannel) {
  if (!homeChannel || typeof homeChannel !== "object") return null;
  return (
    homeChannel.name ||
    homeChannel.display_name ||
    homeChannel.id ||
    homeChannel.channel_id ||
    null
  );
}

function discoveredTargetLabel(target) {
  if (!target || typeof target !== "object") {
    return String(target || "");
  }

  return (
    target.name ||
    target.display_name ||
    target.handle ||
    target.identifier ||
    target.id ||
    target.channel_id ||
    target.address ||
    JSON.stringify(target)
  );
}

function initialValuesForDefinition(definition, currentConfig = {}) {
  return (definition?.configFields || []).reduce((values, field) => {
    values[field.key] = currentConfig?.[field.key] || "";
    return values;
  }, {});
}

function channelTone(channel) {
  if (channel?.status?.errorMessage) {
    return "bg-rose-50 text-rose-700";
  }
  if (channel?.status?.state === "connected") {
    return "bg-emerald-50 text-emerald-700";
  }
  if (channel?.configured) {
    return "bg-sky-50 text-sky-700";
  }
  return "bg-slate-100 text-slate-600";
}

export default function HermesChannelsPanel({ agentId }) {
  const [payload, setPayload] = useState({
    channels: [],
    availableTypes: [],
    gateway: null,
    directoryUpdatedAt: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [editorMode, setEditorMode] = useState("create");
  const [selectedType, setSelectedType] = useState("");
  const [formValues, setFormValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const toast = useToast();

  async function loadChannels() {
    setLoading(true);
    setError("");

    try {
      const res = await fetchWithAuth(`/api/agents/${agentId}/hermes-ui/channels`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load Hermes channels");
      }

      setPayload({
        channels: Array.isArray(data?.channels) ? data.channels : [],
        availableTypes: Array.isArray(data?.availableTypes) ? data.availableTypes : [],
        gateway: data?.gateway || null,
        directoryUpdatedAt: data?.directoryUpdatedAt || null,
      });
    } catch (nextError) {
      setError(nextError.message || "Failed to load Hermes channels");
      setPayload({
        channels: [],
        availableTypes: [],
        gateway: null,
        directoryUpdatedAt: null,
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadChannels();
  }, [agentId]);

  const channels = payload.channels || [];
  const availableTypes = payload.availableTypes || [];

  const configuredTypes = useMemo(() => {
    return new Set(
      channels
        .filter((channel) => channel?.configured && !channel?.readOnly)
        .map((channel) => channel.type)
    );
  }, [channels]);

  const creatableTypes = useMemo(() => {
    return availableTypes.filter((type) => !configuredTypes.has(type.type));
  }, [availableTypes, configuredTypes]);

  const activeDefinition =
    availableTypes.find((type) => type.type === selectedType || type.id === selectedType) ||
    null;

  function closeEditor() {
    setShowEditor(false);
    setEditorMode("create");
    setSelectedType("");
    setFormValues({});
    setSaving(false);
  }

  function openCreateEditor() {
    const nextType = creatableTypes[0]?.type || "";
    setEditorMode("create");
    setSelectedType(nextType);
    setFormValues(
      initialValuesForDefinition(
        availableTypes.find((type) => type.type === nextType) || null
      )
    );
    setShowEditor(true);
  }

  function openEditEditor(channel) {
    const definition = availableTypes.find((type) => type.type === channel.type) || {
      type: channel.type,
      configFields: channel.configFields || [],
    };
    setEditorMode("edit");
    setSelectedType(channel.type);
    setFormValues(initialValuesForDefinition(definition, channel.config));
    setShowEditor(true);
  }

  async function handleSave() {
    if (!selectedType) return;
    setSaving(true);
    setError("");

    const endpoint =
      editorMode === "create"
        ? `/api/agents/${agentId}/hermes-ui/channels`
        : `/api/agents/${agentId}/hermes-ui/channels/${selectedType}`;
    const method = editorMode === "create" ? "POST" : "PATCH";

    try {
      const res = await fetchWithAuth(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editorMode === "create"
            ? { type: selectedType, config: formValues }
            : { config: formValues }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to save Hermes channel");
      }

      if (data?.payload) {
        setPayload({
          channels: Array.isArray(data.payload.channels) ? data.payload.channels : [],
          availableTypes: Array.isArray(data.payload.availableTypes)
            ? data.payload.availableTypes
            : availableTypes,
          gateway: data.payload.gateway || null,
          directoryUpdatedAt: data.payload.directoryUpdatedAt || null,
        });
      } else {
        await loadChannels();
      }

      toast.success(
        editorMode === "create" ? "Channel saved to Hermes" : "Channel updated"
      );
      closeEditor();
    } catch (nextError) {
      const message = nextError.message || "Failed to save Hermes channel";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(channel) {
    setDeletingId(channel.type);
    setError("");

    try {
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/hermes-ui/channels/${channel.type}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete Hermes channel");
      }

      setPayload({
        channels: Array.isArray(data?.channels) ? data.channels : [],
        availableTypes: Array.isArray(data?.availableTypes)
          ? data.availableTypes
          : availableTypes,
        gateway: data?.gateway || null,
        directoryUpdatedAt: data?.directoryUpdatedAt || null,
      });
      toast.success("Channel removed");
    } catch (nextError) {
      const message = nextError.message || "Failed to delete Hermes channel";
      setError(message);
      toast.error(message);
    } finally {
      setDeletingId("");
    }
  }

  async function handleTest(channel) {
    setTestingId(channel.type);
    setError("");

    try {
      const res = await fetchWithAuth(
        `/api/agents/${agentId}/hermes-ui/channels/${channel.type}/test`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to test Hermes channel");
      }

      if (data.success) {
        toast.success(data.message || `${channel.name} is healthy`);
      } else {
        toast.error(data.error || data.message || `${channel.name} test failed`);
      }
    } catch (nextError) {
      const message = nextError.message || "Failed to test Hermes channel";
      setError(message);
      toast.error(message);
    } finally {
      setTestingId("");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700">
              Hermes Channels
            </p>
            <p className="mt-1 text-sm font-bold text-slate-900">
              Configure Hermes-native communication platforms and inspect discovered targets.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Gateway snapshot updated{" "}
              {formatTimestamp(payload.directoryUpdatedAt || payload.gateway?.updatedAt) || "recently"}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadChannels}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button
              onClick={openCreateEditor}
              disabled={creatableTypes.length === 0}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={12} />
              Add Channel
            </button>
          </div>
        </div>

        {payload.gateway ? (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                Gateway State
              </p>
              <p className="mt-2 text-sm font-bold text-slate-900">
                {payload.gateway.state || "Unknown"}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                Configured Platforms
              </p>
              <p className="mt-2 text-sm font-bold text-slate-900">
                {payload.gateway.configuredPlatformsCount ?? 0}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                Discovered Targets
              </p>
              <p className="mt-2 text-sm font-bold text-slate-900">
                {payload.gateway.discoveredTargetsCount ?? 0}
              </p>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-bold text-rose-800">Channel request failed</p>
              <p className="mt-1 text-xs text-rose-700">{error}</p>
            </div>
          </div>
        ) : null}

        {channels.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
            <PlugZap size={24} className="mx-auto text-slate-300" />
            <p className="mt-3 text-sm font-bold text-slate-600">
              No Hermes channels configured yet
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Add a messaging platform to let Hermes send and receive messages outside the runtime.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {channels.map((channel) => {
              const targetLabels = (channel.discoveredTargets || [])
                .map(discoveredTargetLabel)
                .filter(Boolean);
              const visibleTargets = targetLabels.slice(0, 4);
              const moreTargets = Math.max(0, targetLabels.length - visibleTargets.length);
              const homeLabel = homeChannelLabel(channel.homeChannel);

              return (
                <div
                  key={channel.type}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-lg">
                          {channel.emoji || "?"}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-900">{channel.name}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                              {channel.type}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${channelTone(
                                channel
                              )}`}
                            >
                              {channel.status?.state || (channel.configured ? "configured" : "idle")}
                            </span>
                            {channel.readOnly ? (
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-500">
                                Read only
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <p className="mt-3 text-sm text-slate-600">{channel.description}</p>

                      {channel.status?.errorMessage ? (
                        <p className="mt-2 text-xs text-rose-600">{channel.status.errorMessage}</p>
                      ) : null}

                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1">
                          configured: {channel.configured ? "yes" : "no"}
                        </span>
                        {homeLabel ? (
                          <span className="rounded-full bg-slate-100 px-2.5 py-1">
                            home: {homeLabel}
                          </span>
                        ) : null}
                        {channel.status?.updatedAt ? (
                          <span className="rounded-full bg-slate-100 px-2.5 py-1">
                            updated: {formatTimestamp(channel.status.updatedAt)}
                          </span>
                        ) : null}
                      </div>

                      {visibleTargets.length > 0 ? (
                        <div className="mt-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                            Discovered Targets
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {visibleTargets.map((target) => (
                              <span
                                key={`${channel.type}-${target}`}
                                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"
                              >
                                {target}
                              </span>
                            ))}
                            {moreTargets > 0 ? (
                              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">
                                +{moreTargets} more
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      {!channel.readOnly ? (
                        <button
                          onClick={() => openEditEditor(channel)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleTest(channel)}
                        disabled={testingId === channel.type}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-sky-200 px-3 py-2 text-xs font-bold text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-50"
                      >
                        {testingId === channel.type ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <SearchCheck size={12} />
                        )}
                        Test
                      </button>
                      {!channel.readOnly ? (
                        <button
                          onClick={() => handleDelete(channel)}
                          disabled={deletingId === channel.type}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                        >
                          {deletingId === channel.type ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showEditor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 p-4">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  {editorMode === "create" ? "Add Hermes Channel" : "Edit Hermes Channel"}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  Hermes stores these settings in its runtime configuration and may restart after save.
                </p>
              </div>
              <button
                onClick={closeEditor}
                className="text-slate-400 transition-colors hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 p-4">
              {editorMode === "create" ? (
                <div>
                  <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                    Channel Type
                  </label>
                  <select
                    value={selectedType}
                    onChange={(event) => {
                      const nextType = event.target.value;
                      setSelectedType(nextType);
                      setFormValues(
                        initialValuesForDefinition(
                          availableTypes.find((type) => type.type === nextType) || null
                        )
                      );
                    }}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    {creatableTypes.length > 0 ? (
                      creatableTypes.map((type) => (
                        <option key={type.type} value={type.type}>
                          {type.label}
                        </option>
                      ))
                    ) : (
                      <option value="">No additional channel types available</option>
                    )}
                  </select>
                </div>
              ) : null}

              {activeDefinition?.description ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  {activeDefinition.description}
                </div>
              ) : null}

              {(activeDefinition?.configFields || []).length > 0 ? (
                <div className="space-y-3">
                  {(activeDefinition.configFields || []).map((field) => (
                    <div key={field.key}>
                      <label className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
                        {field.label}
                        {field.required ? <span className="ml-1 text-rose-500">*</span> : null}
                      </label>

                      {Array.isArray(field.options) ? (
                        <select
                          value={formValues[field.key] || ""}
                          onChange={(event) =>
                            setFormValues((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                        >
                          <option value="">Select...</option>
                          {field.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={
                            field.type === "password" ||
                            field.type === "email" ||
                            field.type === "url"
                              ? field.type
                              : "text"
                          }
                          value={formValues[field.key] || ""}
                          onChange={(event) =>
                            setFormValues((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }))
                          }
                          placeholder={field.placeholder || ""}
                          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                        />
                      )}

                      {field.type === "password" ? (
                        <p className="mt-1 text-[11px] text-slate-500">
                          Leave the existing masked value untouched to keep the stored secret.
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                  This channel type does not expose editable Nora fields yet.
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-4">
              <button
                onClick={closeEditor}
                className="rounded-xl px-3 py-2 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !selectedType}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save Channel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
