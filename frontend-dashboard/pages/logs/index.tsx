import { useCallback, useDeferredValue, useEffect, useState } from "react";
import Layout from "../../components/layout/Layout";
import {
  Activity,
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  FilterX,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShoppingBag,
  Square,
  Trash2,
  UserCog,
} from "lucide-react";
import { fetchWithAuth } from "../../lib/api";

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
  marketplace_install: {
    icon: ShoppingBag,
    color: "text-violet-600 bg-violet-50",
  },
  marketplace_submitted: {
    icon: ShoppingBag,
    color: "text-amber-600 bg-amber-50",
  },
  marketplace_reported: {
    icon: AlertCircle,
    color: "text-rose-600 bg-rose-50",
  },
  admin_action_failed: { icon: AlertCircle, color: "text-red-600 bg-red-50" },
  agent_action_failed: { icon: AlertCircle, color: "text-red-600 bg-red-50" },
  marketplace_action_failed: {
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
  const kind =
    source.kind || (account ? "account" : metadata.request ? "request" : "system");
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
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
        {label}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-relaxed">
        {value}
      </p>
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
            <p className="text-sm font-semibold text-slate-950">
              {event.message}
            </p>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
              {event.type}
            </span>
          </div>

          <p className="mt-2 text-sm text-slate-500">
            {formatDateTime(event.created_at)}
          </p>

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
              <p className="mt-2 text-sm font-semibold text-red-900">
                {errorMessage}
              </p>
              {errorMeta ? (
                <p className="mt-2 text-xs font-medium text-red-700">
                  {errorMeta}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DetailBox
              label="Source"
              value={formatSourceDetail(source)}
              tone="slate"
            />
            <DetailBox
              label="Source Account"
              value={formatSourceAccountValue(source)}
              tone="slate"
            />
            <DetailBox
              label="Request Origin"
              value={formatRequestOrigin(source)}
              tone="slate"
            />
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
              value={
                metadata.agent?.ownerEmail ||
                metadata.agent?.ownerUserId ||
                null
              }
              tone="blue"
            />
            <DetailBox
              label="Report Reason"
              value={metadata.report?.reason || null}
              tone="slate"
            />
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

export default function LogsPage() {
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
        setAvailableTypes(
          Array.isArray(payload?.availableTypes) ? payload.availableTypes : []
        );
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
    [deferredSearch, typeFilter, fromDate, toDate, page, limit]
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
  const pageStart =
    totalRecords === 0 ? 0 : (currentPage - 1) * currentLimit + 1;
  const pageEnd =
    totalRecords === 0 ? 0 : Math.min(currentPage * currentLimit, totalRecords);
  const hasFilters =
    Boolean(search.trim()) ||
    (typeFilter && typeFilter !== "all") ||
    Boolean(fromDate) ||
    Boolean(toDate);
  const pageItems = buildPageItems(currentPage, totalPages);

  return (
    <Layout>
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
              Review only the events tied to your account, your owned agents,
              and your marketplace activity. Filter by date range and event
              type, then page through the full history.
            </p>
          </div>

          <button
            onClick={() => loadEvents()}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw
              size={16}
              className={loading || refreshing ? "animate-spin" : ""}
            />
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
                    <span
                      key={item}
                      className="px-2 text-sm font-semibold text-slate-400"
                    >
                      …
                    </span>
                  )
                )}
              </div>

              <button
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
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
    </Layout>
  );
}
