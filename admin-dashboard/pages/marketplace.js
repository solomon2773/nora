import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Eye,
  Flag,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Trash2,
  Users,
  XCircle,
} from "lucide-react";
import AdminLayout from "../components/AdminLayout";
import { useToast } from "../components/Toast";
import { fetchWithAuth } from "../lib/api";
import { formatDate, formatCount } from "../lib/format";

const STATUS_STYLES = {
  pending_review: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  removed: "bg-slate-100 text-slate-700 border-slate-200",
};

export default function MarketplaceAdmin() {
  const [items, setItems] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState("");
  const toast = useToast();

  const loadItems = useCallback(async () => {
    try {
      const [listingsResponse, reportsResponse] = await Promise.all([
        fetchWithAuth("/api/admin/marketplace"),
        fetchWithAuth("/api/admin/marketplace/reports"),
      ]);
      if (!listingsResponse.ok) {
        throw new Error("Failed to load marketplace listings");
      }
      if (!reportsResponse.ok) {
        throw new Error("Failed to load marketplace reports");
      }

      const [listingsData, reportsData] = await Promise.all([
        listingsResponse.json(),
        reportsResponse.json(),
      ]);
      setItems(Array.isArray(listingsData) ? listingsData : []);
      setReports(Array.isArray(reportsData) ? reportsData : []);
    } catch (error) {
      console.error("Failed to load marketplace admin data:", error);
      toast.error(error.message || "Failed to load marketplace");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  async function changeListingStatus(item, status) {
    setActionKey(`${item.id}:${status}`);
    try {
      const response = await fetchWithAuth(`/api/admin/marketplace/${item.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to update listing");
      }

      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, ...payload } : entry))
      );
      setReports((current) =>
        current.map((entry) =>
          entry.listing_id === item.id ? { ...entry, status: "resolved" } : entry
        )
      );
      toast.success(`Listing marked ${status.replace(/_/g, " ")}`);
    } catch (error) {
      console.error("Failed to update listing:", error);
      toast.error(error.message || "Failed to update listing");
    } finally {
      setActionKey("");
    }
  }

  async function resolveReport(reportId, status) {
    setActionKey(`report:${reportId}:${status}`);
    try {
      const response = await fetchWithAuth(`/api/admin/marketplace/reports/${reportId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to resolve report");
      }

      setReports((current) =>
        current.map((entry) => (entry.id === reportId ? payload : entry))
      );
      toast.success(`Report marked ${payload.status}`);
    } catch (error) {
      console.error("Failed to resolve report:", error);
      toast.error(error.message || "Failed to resolve report");
    } finally {
      setActionKey("");
    }
  }

  const openReports = reports.filter((report) => report.status === "open");

  return (
    <AdminLayout>
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-red-500">
              Marketplace Admin
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
              Marketplace moderation
            </h1>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              Review community submissions, inspect real template details, approve or reject listings, and resolve user reports.
            </p>
          </div>

          <button
            onClick={() => {
              setLoading(true);
              loadItems();
            }}
            className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </header>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <MetricPill
              icon={ShoppingBag}
              label="Listings"
              value={formatCount(items.length)}
            />
            <MetricPill
              icon={Flag}
              label="Open Reports"
              value={formatCount(openReports.length)}
            />
          </div>

          {loading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 size={28} className="animate-spin text-red-500" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
              <ShoppingBag size={34} className="mb-3 opacity-60" />
              <p className="text-sm font-semibold">No marketplace listings found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Listing
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Source
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Status
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Reports
                    </th>
                    <th className="px-2 py-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Created
                    </th>
                    <th className="px-2 py-3 text-right text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const sourceIsPlatform = item.source_type === "platform";
                    const statusClass =
                      STATUS_STYLES[item.status] ||
                      "bg-slate-100 text-slate-700 border-slate-200";
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-slate-100 last:border-b-0"
                      >
                        <td className="px-2 py-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-950">
                              {item.name}
                            </p>
                            <p className="mt-1 max-w-xl text-sm text-slate-500">
                              {item.description}
                            </p>
                            <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
                              {item.category || "General"} {item.owner_email ? `· ${item.owner_email}` : ""}
                            </p>
                            <p className="mt-2 text-xs font-semibold text-slate-500">
                              v{item.current_version || 1} · {item.template?.presentRequiredCoreCount || 0}/{item.template?.requiredCoreCount || 7} core files · {item.template?.fileCount || 0} files
                            </p>
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest">
                            {sourceIsPlatform ? (
                              <>
                                <ShieldCheck size={12} className="text-blue-600" />
                                Platform
                              </>
                            ) : (
                              <>
                                <Users size={12} className="text-emerald-600" />
                                Community
                              </>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-4">
                          <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${statusClass}`}>
                            {String(item.status || "unknown").replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-2 py-4 text-sm font-medium text-slate-600">
                          {formatCount(item.open_report_count)}
                        </td>
                        <td className="px-2 py-4 text-sm font-medium text-slate-500">
                          {formatDate(item.created_at)}
                        </td>
                        <td className="px-2 py-4">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Link
                              href={`/marketplace/${item.id}`}
                              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                            >
                              <Eye size={15} />
                              Inspect
                            </Link>
                            <ModerationButton
                              disabled={actionKey === `${item.id}:published`}
                              onClick={() => changeListingStatus(item, "published")}
                              tone="green"
                              icon={CheckCircle2}
                              label="Approve"
                            />
                            <ModerationButton
                              disabled={actionKey === `${item.id}:rejected`}
                              onClick={() => changeListingStatus(item, "rejected")}
                              tone="red"
                              icon={XCircle}
                              label="Reject"
                            />
                            <ModerationButton
                              disabled={actionKey === `${item.id}:removed`}
                              onClick={() => changeListingStatus(item, "removed")}
                              tone="slate"
                              icon={Trash2}
                              label="Remove"
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              User reports
            </h2>
            <p className="mt-1 text-sm font-medium text-slate-500">
              {formatCount(openReports.length)} open report{openReports.length === 1 ? "" : "s"} awaiting review.
            </p>
          </div>

          {loading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-red-500" />
            </div>
          ) : openReports.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-200 bg-slate-50 text-center text-slate-400">
              <Flag size={30} className="mb-3 opacity-60" />
              <p className="text-sm font-semibold">No open marketplace reports.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {openReports.map((report) => (
                <div
                  key={report.id}
                  className="rounded-[1.5rem] border border-slate-100 p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-slate-950">
                        {report.listing_name}
                      </p>
                      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">
                        {report.reason} {report.reporter_email ? `· ${report.reporter_email}` : ""}
                      </p>
                      {report.details ? (
                        <p className="text-sm text-slate-500">{report.details}</p>
                      ) : null}
                      <p className="text-xs text-slate-400">
                        Reported {formatDate(report.created_at)}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/marketplace/${report.listing_id}`}
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        <Eye size={15} />
                        Inspect
                      </Link>
                      <ModerationButton
                        disabled={actionKey === `report:${report.id}:resolved`}
                        onClick={() => resolveReport(report.id, "resolved")}
                        tone="green"
                        icon={CheckCircle2}
                        label="Resolve"
                      />
                      <ModerationButton
                        disabled={actionKey === `report:${report.id}:dismissed`}
                        onClick={() => resolveReport(report.id, "dismissed")}
                        tone="slate"
                        icon={XCircle}
                        label="Dismiss"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AdminLayout>
  );
}

function MetricPill({ icon: Icon, label, value }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white shadow-sm">
        <Icon size={18} className="text-slate-700" />
      </div>
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
          {label}
        </p>
        <p className="text-base font-black text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function ModerationButton({ icon: Icon, label, onClick, disabled, tone }) {
  const toneClass =
    tone === "green"
      ? "border-emerald-100 text-emerald-700 hover:bg-emerald-50"
      : tone === "red"
        ? "border-red-100 text-red-700 hover:bg-red-50"
        : "border-slate-200 text-slate-700 hover:bg-slate-50";

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${toneClass}`}
    >
      {disabled ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />}
      {label}
    </button>
  );
}
