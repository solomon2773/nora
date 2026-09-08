import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Layout from "../../components/layout/Layout";
import {
  Activity,
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FilterX,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  Search,
  ShoppingBag,
  Square,
  Trash2,
  UserCog,
  Waypoints,
} from "lucide-react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  getActiveWorkspaceId,
  listWorkspaceAgents,
  listWorkspaces,
  setActiveWorkspaceId,
  subscribeToActiveWorkspace,
  type Workspace,
  type WorkspaceAgent,
} from "../../lib/workspaceClient";
import {
  exportLogs,
  fetchCapacityHaltWindows,
  getCurrentCapacityStatus,
  getTraceDetail,
  listTraces,
  resolveRuntimeLensCapability,
  resolveTracesLensView,
  searchLogs,
  type CapacityHaltWindow,
  type LogLine,
  type LogStream,
  type TraceDetail,
  type TraceSummary,
} from "../../lib/observabilityClient";
import { runtimeSupportsGateway } from "../../lib/runtime";
import LogFilterBar from "../../components/logs/LogFilterBar";
import LogTable from "../../components/logs/LogTable";
import TraceList from "../../components/logs/TraceList";
import TraceWaterfall from "../../components/logs/TraceWaterfall";

const PAGE_SIZE_OPTIONS = [10, 30, 50, 100];

const EVENT_ICONS = {
  agent_deployed: { icon: Bot, color: "text-blue-600 bg-blue-50" },
  agent_redeployed: { icon: RefreshCw, color: "text-blue-600 bg-blue-50" },
  agent_started: { icon: Play, color: "text-emerald-600 bg-emerald-50" },
  agent_stopped: { icon: Square, color: "text-orange-600 bg-orange-50" },
  agent_restarted: { icon: RefreshCw, color: "text-blue-600 bg-blue-50" },
  agent_deleted: { icon: Trash2, color: "text-red-600 bg-red-50" },
  admin_user_role_changed: {
    icon: UserCog,
    color: "text-violet-600 bg-violet-50",
  },
  agent_hub_install: {
    icon: ShoppingBag,
    color: "text-violet-600 bg-violet-50",
  },
  agent_hub_download: {
    icon: Download,
    color: "text-violet-600 bg-violet-50",
  },
  agent_hub_shared: {
    icon: ShoppingBag,
    color: "text-amber-600 bg-amber-50",
  },
  agent_hub_reported: {
    icon: AlertCircle,
    color: "text-rose-600 bg-rose-50",
  },
  admin_action_failed: { icon: AlertCircle, color: "text-red-600 bg-red-50" },
  agent_action_failed: { icon: AlertCircle, color: "text-red-600 bg-red-50" },
  agent_hub_action_failed: {
    icon: AlertCircle,
    color: "text-red-600 bg-red-50",
  },
  error: { icon: AlertCircle, color: "text-red-600 bg-red-50" },
  default: { icon: Activity, color: "text-slate-500 bg-slate-100" },
};

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toLocaleString();
}

function formatShortId(value, length = 8) {
  if (!value) return "—";
  return String(value).slice(0, length);
}

function normalizeMetadata(rawMetadata) {
  if (!rawMetadata) return {};
  if (typeof rawMetadata === "string") {
    try {
      return JSON.parse(rawMetadata);
    } catch {
      return { raw: rawMetadata };
    }
  }
  return rawMetadata;
}

function formatJson(value) {
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch {
    return "{}";
  }
}

function formatEventTypeLabel(type) {
  if (!type) return "All activity";
  return type.replace(/_/g, " ");
}

function formatSourceKind(kind) {
  if (kind === "account") return "Account";
  if (kind === "request") return "Request";
  return "System";
}

function resolveSource(metadata) {
  const source = metadata.source || {};
  const actor = metadata.actor || {};
  const account =
    source.account ||
    (actor.email || actor.userId || actor.role
      ? {
          email: actor.email || null,
          userId: actor.userId || null,
          role: actor.role || null,
        }
      : null);
  const kind = source.kind || (account ? "account" : metadata.request ? "request" : "system");
  const service = source.service || "backend-api";

  return {
    kind,
    label:
      source.label ||
      account?.email ||
      account?.userId ||
      (kind === "request" ? "Unauthenticated request" : `System · ${service}`),
    service,
    channel: source.channel || null,
    account,
    ip: source.ip || metadata.request?.ip || null,
    origin: source.origin || metadata.request?.origin || null,
    userAgent: source.userAgent || metadata.request?.userAgent || null,
  };
}

function formatSourceDetail(source) {
  const parts = [formatSourceKind(source.kind)];
  if (source.service) parts.push(source.service);
  if (source.channel) parts.push(source.channel);
  return parts.join(" · ");
}

function formatSourceAccountValue(source) {
  if (!source.account) return null;
  const details = [source.account.email || source.account.userId || null];
  if (source.account.role) details.push(source.account.role);
  return details.filter(Boolean).join(" · ");
}

function formatRequestOrigin(source) {
  const lines = [];
  if (source.ip) lines.push(`IP: ${source.ip}`);
  if (source.origin) lines.push(`Origin: ${source.origin}`);
  if (source.userAgent) lines.push(`User agent: ${source.userAgent}`);
  return lines.join("\n") || null;
}

function buildQueryString({
  search = "",
  type = "all",
  from = "",
  to = "",
  page = 1,
  limit = 30,
} = {}) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  if (search.trim()) params.set("search", search.trim());
  if (type && type !== "all") params.set("type", type);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params.toString();
}

function buildPageItems(currentPage, totalPages) {
  if (totalPages <= 1) return [1];

  const values = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const pages = [...values]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b);

  const items = [];
  pages.forEach((value, index) => {
    const previous = pages[index - 1];
    if (previous && value - previous > 1) {
      items.push(`ellipsis-${value}`);
    }
    items.push(value);
  });

  return items;
}

function buildHighlights(metadata) {
  const source = resolveSource(metadata);
  const items = [
    {
      label: "Source",
      value: formatSourceKind(source.kind),
      tone:
        source.kind === "account"
          ? "bg-cyan-50 text-cyan-700"
          : source.kind === "request"
            ? "bg-amber-50 text-amber-700"
            : "bg-slate-950 text-slate-100",
    },
  ];

  if (metadata.agent?.name || metadata.agent?.id) {
    items.push({
      label: "Agent",
      value: metadata.agent.name || formatShortId(metadata.agent.id),
      tone: "bg-blue-50 text-blue-700",
    });
  }

  if (metadata.listing?.name || metadata.listing?.id) {
    items.push({
      label: "Listing",
      value: metadata.listing.name || formatShortId(metadata.listing.id),
      tone: "bg-violet-50 text-violet-700",
    });
  }

  if (metadata.request?.method && metadata.request?.path) {
    items.push({
      label: "Request",
      value: `${metadata.request.method} ${metadata.request.path}`,
      tone: "bg-slate-100 text-slate-700",
    });
  }

  if (metadata.request?.correlationId) {
    items.push({
      label: "Ref",
      value: formatShortId(metadata.request.correlationId, 12),
      tone: "bg-slate-200 text-slate-700",
    });
  }

  if (metadata.result?.status || metadata.result?.nextStatus) {
    items.push({
      label: "Result",
      value: metadata.result.nextStatus || metadata.result.status,
      tone: "bg-emerald-50 text-emerald-700",
    });
  }

  return items;
}

function DetailBox({ label, value, tone = "slate" }) {
  if (!value) return null;

  const tones = {
    slate: "bg-slate-50 text-slate-800",
    red: "bg-red-50 text-red-900",
    blue: "bg-blue-50 text-blue-900",
  };

  return (
    <div className={`rounded-2xl px-4 py-4 ${tones[tone] || tones.slate}`}>
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-relaxed">{value}</p>
    </div>
  );
}

function EventCard({ event }) {
  const metadata = normalizeMetadata(event.metadata);
  const source = resolveSource(metadata);
  const config = EVENT_ICONS[event.type] || EVENT_ICONS.default;
  const Icon = config.icon;
  const highlights = buildHighlights(metadata);
  const errorMessage = metadata.error?.message || null;
  const errorMeta = [
    metadata.error?.name,
    metadata.error?.code,
    metadata.error?.status ? `status ${metadata.error.status}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-[1.5rem] border border-slate-200 bg-white px-4 py-4 shadow-sm transition-colors hover:bg-slate-50">
      <div className="flex items-start gap-4">
        <div
          className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${config.color}`}
        >
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-950">{event.message}</p>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              {event.type}
            </span>
          </div>

          <p className="mt-2 text-sm text-slate-500">{formatDateTime(event.created_at)}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            {highlights.map((item) => (
              <span
                key={`${event.id}-${item.label}`}
                className={`rounded-full px-3 py-1 text-[11px] font-bold ${item.tone}`}
              >
                {item.label}: {item.value}
              </span>
            ))}
          </div>

          {errorMessage ? (
            <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 px-4 py-4">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-red-500">
                Error
              </p>
              <p className="mt-2 text-sm font-semibold text-red-900">{errorMessage}</p>
              {errorMeta ? (
                <p className="mt-2 text-xs font-medium text-red-700">{errorMeta}</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DetailBox label="Source" value={formatSourceDetail(source)} tone="slate" />
            <DetailBox
              label="Source Account"
              value={formatSourceAccountValue(source)}
              tone="slate"
            />
            <DetailBox label="Request Origin" value={formatRequestOrigin(source)} tone="slate" />
            <DetailBox
              label="Role Change"
              value={
                metadata.result?.previousRole && metadata.result?.nextRole
                  ? `${metadata.result.previousRole} -> ${metadata.result.nextRole}`
                  : null
              }
              tone="blue"
            />
            <DetailBox
              label="Status Change"
              value={
                metadata.result?.previousStatus && metadata.result?.nextStatus
                  ? `${metadata.result.previousStatus} -> ${metadata.result.nextStatus}`
                  : metadata.result?.status || null
              }
              tone="blue"
            />
            <DetailBox
              label="Listing"
              value={metadata.listing?.name || metadata.listing?.id || null}
              tone="blue"
            />
            <DetailBox
              label="Agent Owner"
              value={metadata.agent?.ownerEmail || metadata.agent?.ownerUserId || null}
              tone="blue"
            />
            <DetailBox label="Report Reason" value={metadata.report?.reason || null} tone="slate" />
            <DetailBox
              label="Report Details"
              value={metadata.reportDetails?.details || null}
              tone="slate"
            />
            <DetailBox
              label="Deploy Context"
              value={
                metadata.deploy
                  ? `${metadata.deploy.type || "deploy"} · ${metadata.deploy.specs?.vcpu || "?"} vCPU · ${metadata.deploy.specs?.ram_mb || "?"} MB RAM · ${metadata.deploy.specs?.disk_gb || "?"} GB disk`
                  : null
              }
              tone="slate"
            />
          </div>

          <details className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 text-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold">
              <span>Raw event metadata</span>
              <ChevronDown size={16} className="text-slate-400" />
            </summary>
            <pre className="max-h-[420px] overflow-auto border-t border-slate-800 p-4 text-xs leading-relaxed text-slate-200">
              {formatJson(metadata)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}

// ── Operator lens ───────────────────────────────────────────────────────
//
// This is the page's original (pre-Phase-8) content, relocated unchanged
// under a tab. Its logic — filters, pagination, polling — is untouched;
// only its position on the page (now one of three lenses) has moved.
function OperatorLens() {
  const [events, setEvents] = useState([]);
  const [availableTypes, setAvailableTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(30);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 30,
    total: 0,
    totalPages: 1,
  });
  const deferredSearch = useDeferredValue(search);

  const loadEvents = useCallback(
    async ({ silent = false } = {}) => {
      const queryString = buildQueryString({
        search: deferredSearch,
        type: typeFilter,
        from: fromDate,
        to: toDate,
        page,
        limit,
      });

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setError("");
      }

      try {
        const response = await fetchWithAuth(`/api/monitoring/events?${queryString}`);
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to load your activity log");
        }

        setEvents(Array.isArray(payload?.events) ? payload.events : []);
        setAvailableTypes(Array.isArray(payload?.availableTypes) ? payload.availableTypes : []);
        setPagination({
          page: payload?.page || 1,
          limit: payload?.limit || limit,
          total: payload?.total || 0,
          totalPages: payload?.totalPages || 1,
        });

        if (payload?.page && payload.page !== page) {
          setPage(payload.page);
        }
      } catch (loadError) {
        console.error("Failed to load user logs:", loadError);
        setError(loadError.message || "Failed to load your activity log");
        if (!silent) {
          setEvents([]);
          setPagination((current) => ({
            ...current,
            total: 0,
            totalPages: 1,
          }));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [deferredSearch, typeFilter, fromDate, toDate, page, limit],
  );

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      loadEvents({ silent: true });
    }, 30000);

    return () => clearInterval(intervalId);
  }, [loadEvents]);

  const resetFilters = () => {
    setSearch("");
    setTypeFilter("all");
    setFromDate("");
    setToDate("");
    setLimit(30);
    setPage(1);
    setError("");
  };

  const currentPage = pagination.page || 1;
  const currentLimit = pagination.limit || limit;
  const totalPages = pagination.totalPages || 1;
  const totalRecords = pagination.total || 0;
  const pageStart = totalRecords === 0 ? 0 : (currentPage - 1) * currentLimit + 1;
  const pageEnd = totalRecords === 0 ? 0 : Math.min(currentPage * currentLimit, totalRecords);
  const hasFilters =
    Boolean(search.trim()) ||
    (typeFilter && typeFilter !== "all") ||
    Boolean(fromDate) ||
    Boolean(toDate);
  const pageItems = buildPageItems(currentPage, totalPages);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-600">
            User Activity
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
            Account event log
          </h1>
          <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
            Review only the events tied to your account, your owned agents, and your Agent Hub
            activity. Filter by date range and event type, then page through the full history.
          </p>
        </div>

        <button
          onClick={() => loadEvents()}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={16} className={loading || refreshing ? "animate-spin" : ""} />
          Refresh
        </button>
      </header>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_repeat(4,minmax(0,1fr))]">
          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
              Search
            </span>
            <div className="relative">
              <Search
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Source, agent, request, error, or message"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-200 focus:bg-white"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
              Event Type
            </span>
            <select
              value={typeFilter}
              onChange={(event) => {
                setTypeFilter(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-200 focus:bg-white"
            >
              <option value="all">All activity</option>
              {availableTypes.map((type) => (
                <option key={type} value={type}>
                  {formatEventTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
              From
            </span>
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => {
                setFromDate(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-200 focus:bg-white"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
              To
            </span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => {
                setToDate(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-200 focus:bg-white"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
              Records / page
            </span>
            <select
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setPage(1);
              }}
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:border-blue-200 focus:bg-white"
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3 text-sm font-medium text-slate-500">
            <span>
              Showing {formatCount(pageStart)}-{formatCount(pageEnd)} of{" "}
              {formatCount(totalRecords)} events
            </span>
            {refreshing ? (
              <span className="inline-flex items-center gap-2 text-blue-600">
                <Loader2 size={14} className="animate-spin" />
                Refreshing
              </span>
            ) : null}
          </div>

          {hasFilters ? (
            <button
              onClick={resetFilters}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              <FilterX size={16} />
              Clear filters
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="mt-5 rounded-2xl border border-red-100 bg-red-50 px-4 py-4 text-sm font-medium text-red-800">
            {error}
          </div>
        ) : null}

        <div className="mt-6">
          {loading ? (
            <div className="flex h-56 items-center justify-center">
              <Loader2 size={28} className="animate-spin text-blue-500" />
            </div>
          ) : events.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
              <FileText size={34} className="mb-3 opacity-60" />
              <p className="text-sm font-semibold">
                No account-related events found for the current filters.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-4 border-t border-slate-100 pt-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-sm font-medium text-slate-500">
            Page {formatCount(currentPage)} of {formatCount(totalPages)}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={currentPage <= 1}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft size={16} />
              Previous
            </button>

            <div className="flex flex-wrap items-center gap-2">
              {pageItems.map((item) =>
                typeof item === "number" ? (
                  <button
                    key={item}
                    onClick={() => setPage(item)}
                    className={`h-10 min-w-10 rounded-2xl px-3 text-sm font-semibold transition-colors ${
                      item === currentPage
                        ? "bg-slate-950 text-white"
                        : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {item}
                  </button>
                ) : (
                  <span key={item} className="px-2 text-sm font-semibold text-slate-400">
                    …
                  </span>
                ),
              )}
            </div>

            <button
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={currentPage >= totalPages}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Runtime lens ────────────────────────────────────────────────────────

type NormalizedAgentOption = {
  id: string;
  name: string;
  runtimeFamily: string | null;
  deployTarget: string | null;
};

const DEFAULT_LIVE_TAIL_BUFFER = 5000;
const LIVE_TAIL_UNSUPPORTED_MESSAGE =
  "Live tail requires a running agent. Select a different agent or wait for it to start.";

function isoMinusHours(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runtime lens. Scoped to exactly one agent via the shared header — no
 * agent column on rows (see the Phase 8 spec item 3). Wires:
 *   - `searchLogs`/`exportLogs` (Phase 6/7) for the persisted timeline,
 *   - the existing `attachLogStream` WebSocket (same endpoint LogViewer.tsx
 *     already uses) for live tail — see the comment on `liveTail` below for
 *     why this reuses that mechanism rather than building a new one against
 *     worker-provisioner's buffer.
 */
function RuntimeLens({
  agent,
  workspaceId,
  from,
  to,
}: {
  agent: NormalizedAgentOption | null;
  workspaceId: string | null;
  from: string;
  to: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q);
  const [streams, setStreams] = useState<LogStream[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [liveLines, setLiveLines] = useState<LogLine[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [capacityWindows, setCapacityWindows] = useState<CapacityHaltWindow[]>([]);
  const [storageBackend, setStorageBackend] = useState<string | null>(null);
  const [liveTail, setLiveTail] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);
  const [exporting, setExporting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const liveIdRef = useRef(0);

  const runSearch = useCallback(async () => {
    if (!agent) {
      setLines([]);
      return;
    }
    setLoading(true);
    try {
      const result = await searchLogs({
        workspaceId,
        agentId: agent.id,
        streams: streams.length ? streams : undefined,
        levels: levels.length ? levels : undefined,
        from,
        to,
        q: deferredQ || undefined,
        order: "desc",
        limit: 500,
      });
      setLines(result.lines);
      setWarning(result.warning || null);
    } catch (error) {
      console.error("Failed to search logs:", error);
      setLines([]);
      setWarning(null);
    } finally {
      setLoading(false);
    }
  }, [agent, workspaceId, streams, levels, from, to, deferredQ]);

  useEffect(() => {
    runSearch();
  }, [runSearch]);

  // Item 8a: best-effort capacity-halt window detection. Real signal (the
  // `events` rows Phase 5 item 6 writes), fetched through the already
  // workspace-scoped `GET /monitoring/events` — see
  // observabilityClient.ts's `fetchCapacityHaltWindows` doc comment for the
  // honest caveats (installation-wide origin, client-side pairing).
  useEffect(() => {
    let active = true;
    fetchCapacityHaltWindows(workspaceId, from, to).then((windows) => {
      if (active) setCapacityWindows(windows);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, from, to]);

  // Best-effort storage-backend lookup for the k8s+local capability
  // message (item 8) — only resolves for a platform-admin actor; see
  // `getCurrentCapacityStatus`'s doc comment. Silently stays `null`
  // otherwise, and the capability resolver treats `null` as "unknown"
  // rather than guessing.
  useEffect(() => {
    let active = true;
    fetchWithAuth("/api/admin/log-storage")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (active && body?.storageBackend) setStorageBackend(body.storageBackend);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Live tail — Option A (see Phase 8 spec item 6 / the report handed back
  // with this change): reuse the existing `attachLogStream` WebSocket, the
  // same one `LogViewer.tsx` already opens for the agent detail page,
  // rather than building a new poll against worker-provisioner's internal
  // buffer endpoint. This is the lower-risk, already-proven path, at the
  // ALREADY-ACCEPTED cost the plan names explicitly: an agent with both the
  // detail page and this Runtime lens open concurrently now holds two
  // independent follow streams against the same container. This phase does
  // not fix that pre-existing cost — Design Decision 19 already accepted it
  // for the live viewer alone — it only avoids making it categorically
  // worse by not adding a THIRD mechanism. Rewiring either viewer onto
  // worker-provisioner's buffer (Option B) is unscoped follow-up work.
  useEffect(() => {
    if (!liveTail || !agent) {
      wsRef.current?.close();
      wsRef.current = null;
      setLiveConnected(false);
      return;
    }

    const legacy = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = legacy ? `?token=${encodeURIComponent(legacy)}` : "";
    const url = `${proto}//${window.location.host}/api/ws/logs/${encodeURIComponent(agent.id)}${qs}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setLiveConnected(true);
    ws.onclose = () => setLiveConnected(false);
    ws.onerror = () => setLiveConnected(false);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const line: LogLine = {
          ts: data.timestamp || null,
          observed_ts: data.timestamp || nowIso(),
          ts_source: "source",
          stream: "runtime",
          level: data.level || null,
          message: data.message || "",
          ord: liveIdRef.current++,
          _live: true,
        };
        setLiveLines((previous) => {
          const next = [...previous, line];
          if (next.length > DEFAULT_LIVE_TAIL_BUFFER) {
            next.splice(0, next.length - DEFAULT_LIVE_TAIL_BUFFER);
          }
          return next;
        });
      } catch {
        // Ignore malformed frames rather than crashing the tail.
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [liveTail, agent]);

  useEffect(() => {
    setLiveLines([]);
  }, [agent?.id]);

  const combinedLines = useMemo(() => {
    if (!liveTail || liveLines.length === 0) return lines;
    // Live lines are newest-last; search results are newest-first (desc).
    // Put live lines at the top so the freshest activity stays visible
    // without re-sorting the whole persisted result set on every frame.
    return [...[...liveLines].reverse(), ...lines];
  }, [lines, liveLines, liveTail]);

  const capability = useMemo(
    () =>
      resolveRuntimeLensCapability({
        runtimeSupportsGatewayStream: agent ? runtimeSupportsGateway(agent.runtimeFamily || "") : true,
        streamsFilter: streams,
        storageBackend,
        deployTarget: agent?.deployTarget || null,
        lineCount: combinedLines.length,
      }),
    [agent, streams, storageBackend, combinedLines.length],
  );

  async function handleExport() {
    if (!agent) return;
    setExporting(true);
    try {
      await exportLogs({
        workspaceId,
        agentId: agent.id,
        streams: streams.length ? streams : undefined,
        levels: levels.length ? levels : undefined,
        from,
        to,
        q: deferredQ || undefined,
        format: "ndjson",
      });
    } catch (error) {
      console.error("Failed to export logs:", error);
    } finally {
      setExporting(false);
    }
  }

  if (!agent) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
        <ScrollText size={28} className="opacity-60" />
        <p className="text-sm font-semibold">{t("Select an agent above to view its runtime logs.")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <LogFilterBar
        q={q}
        onQChange={setQ}
        streams={streams}
        onStreamsChange={setStreams}
        levels={levels}
        onLevelsChange={setLevels}
        liveTail={liveTail}
        onLiveTailChange={setLiveTail}
        liveTailConnected={liveConnected}
        onExport={handleExport}
        exporting={exporting}
      />
      <LogTable
        lines={combinedLines}
        loading={loading}
        capability={capability}
        warning={warning}
        capacityWindows={capacityWindows}
        height={520}
      />
    </div>
  );
}

// ── Traces lens (Phase 13) ────────────────────────────────────────────────
//
// List on the left (TraceList), split-pane detail on the right
// (TraceWaterfall: span waterfall above, correlated logs below). Built
// against the ASSUMED API CONTRACT documented at the top of the Traces
// section in observabilityClient.ts — the backend half of this phase
// (`GET /traces`, `GET /traces/:traceId`) is being built concurrently in a
// different worktree from the same plan section, so this component has
// never seen that code. See this file's Phase 13 completion report for the
// exact contract to diff against the real implementation once merged.
function TracesLens({
  agent,
  workspaceId,
  from,
  to,
}: {
  agent: NormalizedAgentOption | null;
  workspaceId: string | null;
  from: string;
  to: string;
}) {
  const { t } = useI18n();
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [tracesEnabled, setTracesEnabled] = useState<boolean | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [tracesLoading, setTracesLoading] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Item 6/7: `tracesEnabled` is read off `GET /traces`'s own response
  // (resolved server-side for the requested agent), not a separate call to
  // the admin-gated `GET /workspaces/:id/log-settings` — see
  // `ListTracesResult.tracesEnabled`'s doc comment in observabilityClient.ts
  // for why: that settings endpoint requires workspace-admin, which would
  // make this lens show the "enable tracing" CTA for a plain viewer/editor
  // even when tracing is genuinely on. No agent selected means nothing to
  // resolve yet, so `tracesEnabled` stays `null` ("unknown" -> CTA per
  // `resolveTracesLensView`) until one is.
  useEffect(() => {
    if (!agent) {
      setTraces([]);
      setTracesEnabled(null);
      setSettingsLoading(false);
      return;
    }
    let active = true;
    setTracesLoading(true);
    setSettingsLoading(true);
    listTraces({ workspaceId, agentId: agent.id, from, to, limit: 100 })
      .then((result) => {
        if (!active) return;
        setTraces(result.traces);
        setTracesEnabled(result.tracesEnabled);
      })
      .catch((error) => {
        console.error("Failed to list traces:", error);
        if (active) {
          setTraces([]);
          setTracesEnabled(null);
        }
      })
      .finally(() => {
        if (active) {
          setTracesLoading(false);
          setSettingsLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [agent, workspaceId, from, to]);

  useEffect(() => {
    setSelectedTraceId(null);
    setDetail(null);
    setDetailError(null);
  }, [agent?.id, workspaceId]);

  useEffect(() => {
    if (!selectedTraceId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError(null);
    getTraceDetail(selectedTraceId)
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((error) => {
        console.error("Failed to load trace detail:", error);
        if (active) {
          setDetail(null);
          setDetailError(error?.message || "Failed to load trace detail");
        }
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedTraceId]);

  if (!agent) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
        <Waypoints size={28} className="opacity-60" />
        <p className="text-sm font-semibold">{t("Select an agent above to view its traces.")}</p>
      </div>
    );
  }

  if (settingsLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  const view = resolveTracesLensView({ tracesEnabled, traceCount: traces.length });

  if (view === "enable_cta") {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 text-center text-slate-500">
        <Waypoints size={28} className="opacity-60" />
        <p className="text-sm font-bold text-slate-700">{t("Tracing is not enabled for this workspace")}</p>
        <p className="max-w-md text-xs text-slate-400">
          {t(
            "Turn on tracing in this workspace's log settings to start collecting spans for its agents. Once enabled, new traces appear here as agents run.",
          )}
        </p>
      </div>
    );
  }

  if (view === "empty" && !tracesLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
        <Waypoints size={28} className="opacity-60" />
        <p className="text-sm font-semibold">{t("No traces in this range.")}</p>
        <p className="max-w-sm text-xs text-slate-400">
          {t("Tracing is enabled, but no spans were recorded for this agent in the selected time range.")}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_1fr]">
      <TraceList
        traces={traces}
        selectedTraceId={selectedTraceId}
        onSelect={setSelectedTraceId}
        loading={tracesLoading}
      />
      <TraceWaterfall detail={detail} loading={detailLoading} error={detailError} />
    </div>
  );
}

// ── Shared page: tabs + header ────────────────────────────────────────────

type LensId = "operator" | "runtime" | "traces";

const LENSES: { id: LensId; label: string; disabled?: boolean }[] = [
  { id: "operator", label: "Operator" },
  { id: "runtime", label: "Runtime" },
  { id: "traces", label: "Traces" },
];

function LensTabBar({
  active,
  onChange,
}: {
  active: LensId;
  onChange: (id: LensId) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex w-full items-center gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 scrollbar-hide">
      {LENSES.map((lens) => (
        <button
          key={lens.id}
          type="button"
          disabled={lens.disabled}
          onClick={() => onChange(lens.id)}
          className={clsx(
            "shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-bold transition-all",
            lens.disabled
              ? "cursor-not-allowed text-slate-300"
              : active === lens.id
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700",
          )}
        >
          {t(lens.label)}
          {lens.disabled ? <span className="ml-1.5 text-[9px] uppercase">{t("Soon")}</span> : null}
        </button>
      ))}
    </div>
  );
}

const TIME_RANGE_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
];

/**
 * Shared header above all three lenses: workspace selector, single-agent
 * selector, time-range picker. Deliberately single-select for both
 * workspace and agent (Phase 8 spec item 2 / the manifest's Non-Goals) —
 * this page answers "what did this one agent do," never "what happened
 * across my agents." The Operator lens (unchanged, above) and
 * `GET /admin/audit` already serve the fleet-wide question.
 */
function SharedHeader({
  workspaceId,
  onWorkspaceChange,
  agent,
  agentOptions,
  onAgentChange,
  rangeHours,
  onRangeChange,
}: {
  workspaceId: string | null;
  onWorkspaceChange: (id: string | null) => void;
  agent: NormalizedAgentOption | null;
  agentOptions: NormalizedAgentOption[];
  onAgentChange: (agentId: string) => void;
  rangeHours: number;
  onRangeChange: (hours: number) => void;
}) {
  const { t } = useI18n();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(() => {
    let active = true;
    listWorkspaces()
      .then((rows) => {
        if (active) setWorkspaces(rows);
      })
      .catch(() => {
        if (active) setWorkspaces([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3">
      <label className="block">
        <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
          {t("Workspace")}
        </span>
        <select
          value={workspaceId || ""}
          onChange={(event) => onWorkspaceChange(event.target.value || null)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-blue-200 focus:bg-white"
        >
          <option value="">{t("My agents (no workspace)")}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
          {t("Agent")}
        </span>
        <select
          value={agent?.id || ""}
          onChange={(event) => onAgentChange(event.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-900 outline-none focus:border-blue-200 focus:bg-white"
        >
          <option value="">{t("Select an agent…")}</option>
          {agentOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
          {t("Time range")}
        </span>
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          {TIME_RANGE_OPTIONS.map((option) => (
            <button
              key={option.hours}
              type="button"
              onClick={() => onRangeChange(option.hours)}
              className={clsx(
                "flex-1 rounded-lg py-1.5 text-xs font-bold transition-all",
                rangeHours === option.hours
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </label>
    </div>
  );
}

export default function LogsPage() {
  const { t } = useI18n();
  const [activeLens, setActiveLens] = useState<LensId>("operator");

  // Shared filter state — persists across lens switches by construction:
  // it lives in this parent component, not inside whichever lens happens
  // to be mounted, so switching tabs never resets it.
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => getActiveWorkspaceId());
  const [agentOptions, setAgentOptions] = useState<NormalizedAgentOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState(1);

  // Item 5: wire into the global active-workspace mechanism. This is the
  // first page in this codebase to scope its own API calls by the active
  // workspace — see observabilityClient.ts / this file's header comments.
  useEffect(() => subscribeToActiveWorkspace(setWorkspaceId), []);

  const handleWorkspaceChange = useCallback((id: string | null) => {
    setActiveWorkspaceId(id);
    setWorkspaceId(id);
    setSelectedAgentId(null);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadAgents() {
      try {
        if (workspaceId) {
          const rows: WorkspaceAgent[] = await listWorkspaceAgents(workspaceId);
          if (!active) return;
          setAgentOptions(
            rows.map((row) => ({
              id: row.agentId,
              name: row.agentName || row.name || row.agentId,
              runtimeFamily: row.runtime_family || null,
              deployTarget: row.deploy_target || null,
            })),
          );
        } else {
          const res = await fetchWithAuth("/api/agents");
          const body = res.ok ? await res.json().catch(() => []) : [];
          if (!active) return;
          const rows = Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : [];
          setAgentOptions(
            rows.map((row: any) => ({
              id: row.id,
              name: row.name || row.id,
              runtimeFamily: row.runtime_family || null,
              deployTarget: row.deploy_target || null,
            })),
          );
        }
      } catch {
        if (active) setAgentOptions([]);
      }
    }
    loadAgents();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const selectedAgent = useMemo(
    () => agentOptions.find((option) => option.id === selectedAgentId) || null,
    [agentOptions, selectedAgentId],
  );

  useEffect(() => {
    if (selectedAgentId && !agentOptions.some((option) => option.id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [agentOptions, selectedAgentId]);

  const from = useMemo(() => isoMinusHours(rangeHours), [rangeHours]);
  const to = useMemo(() => nowIso(), [rangeHours]);

  return (
    <Layout>
      <div className="flex flex-col gap-6">
        <LensTabBar active={activeLens} onChange={setActiveLens} />

        {activeLens !== "operator" ? (
          <SharedHeader
            workspaceId={workspaceId}
            onWorkspaceChange={handleWorkspaceChange}
            agent={selectedAgent}
            agentOptions={agentOptions}
            onAgentChange={setSelectedAgentId}
            rangeHours={rangeHours}
            onRangeChange={setRangeHours}
          />
        ) : null}

        {activeLens === "operator" ? <OperatorLens /> : null}
        {activeLens === "runtime" ? (
          <RuntimeLens agent={selectedAgent} workspaceId={workspaceId} from={from} to={to} />
        ) : null}
        {activeLens === "traces" ? (
          <TracesLens agent={selectedAgent} workspaceId={workspaceId} from={from} to={to} />
        ) : null}
      </div>
    </Layout>
  );
}
