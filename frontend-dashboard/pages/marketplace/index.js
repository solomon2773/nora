import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { clsx } from "clsx";
import {
  ArrowDownToLine,
  Bot,
  ChevronRight,
  ExternalLink,
  Flag,
  FileText,
  Loader2,
  Layers3,
  Plus,
  RefreshCw,
  Share2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import Layout from "../../components/layout/Layout";
import { fetchWithAuth } from "../../lib/api";
import { useToast } from "../../components/Toast";

const MARKETPLACE_TABS = [
  { id: "presets", label: "Platform Presets" },
  { id: "community", label: "Community" },
  { id: "my", label: "My Listings" },
];

const REPORT_REASONS = [
  { value: "spam", label: "Spam or low quality" },
  { value: "unsafe", label: "Unsafe or harmful content" },
  { value: "copyright", label: "Copyright or ownership issue" },
  { value: "misleading", label: "Misleading or inaccurate" },
  { value: "other", label: "Other" },
];

const STATUS_STYLES = {
  pending_review: "bg-amber-50 text-amber-700 border-amber-200",
  published: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
  removed: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatCount(value) {
  const numeric = Number(value || 0);
  if (numeric >= 1000) return `${(numeric / 1000).toFixed(1)}k`;
  return `${numeric}`;
}

function parseFilename(headerValue, fallbackName) {
  const match = /filename="([^"]+)"/i.exec(headerValue || "");
  return match?.[1] || fallbackName;
}

async function downloadResponseAsFile(response, fallbackName) {
  const blob = await response.blob();
  const filename = parseFilename(
    response.headers.get("content-disposition"),
    fallbackName
  );
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

export default function Marketplace() {
  const router = useRouter();
  const toast = useToast();
  const [browseItems, setBrowseItems] = useState([]);
  const [myItems, setMyItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("presets");
  const [category, setCategory] = useState("All");
  const [selectedItem, setSelectedItem] = useState(null);
  const [installName, setInstallName] = useState("");
  const [installingId, setInstallingId] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [reportingId, setReportingId] = useState("");
  const [reportItem, setReportItem] = useState(null);
  const [reportReason, setReportReason] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");

  async function loadMarketplace() {
    setLoading(true);
    try {
      const [browseRes, mineRes] = await Promise.all([
        fetchWithAuth("/api/marketplace"),
        fetchWithAuth("/api/marketplace/mine"),
      ]);

      if (!browseRes.ok) {
        throw new Error("Failed to load marketplace listings");
      }
      if (!mineRes.ok) {
        throw new Error("Failed to load your marketplace listings");
      }

      const [browseData, mineData] = await Promise.all([
        browseRes.json(),
        mineRes.json(),
      ]);
      setBrowseItems(Array.isArray(browseData) ? browseData : []);
      setMyItems(Array.isArray(mineData) ? mineData : []);
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to load marketplace");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMarketplace();
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    const tab = typeof router.query.tab === "string" ? router.query.tab : "";
    if (MARKETPLACE_TABS.some((entry) => entry.id === tab)) {
      setActiveTab(tab);
    }
  }, [router.isReady, router.query.tab]);

  function selectTab(nextTab) {
    setActiveTab(nextTab);
    setCategory("All");
    router.replace(
      {
        pathname: router.pathname,
        query: { ...router.query, tab: nextTab },
      },
      undefined,
      { shallow: true }
    );
  }

  const presets = browseItems.filter((item) => item.source_type === "platform");
  const community = browseItems.filter(
    (item) => item.source_type === "community"
  );
  const scopedItems =
    activeTab === "presets"
      ? presets
      : activeTab === "community"
        ? community
        : myItems;
  const categories = [
    "All",
    ...Array.from(
      new Set(scopedItems.map((item) => item.category).filter(Boolean))
    ),
  ];
  const filteredItems =
    category === "All"
      ? scopedItems
      : scopedItems.filter((item) => item.category === category);

  async function installAgent() {
    if (!selectedItem) return;
    const trimmedName = installName.trim();
    if (!trimmedName) {
      toast.error("Agent name is required");
      return;
    }

    setInstallingId(selectedItem.id);
    try {
      const res = await fetchWithAuth("/api/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: selectedItem.id,
          name: trimmedName,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        toast.success("Template install queued");
        window.location.href = data?.id ? `/app/agents/${data.id}` : "/app/agents";
        return;
      }

      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Failed to install template");
    } catch (error) {
      console.error(error);
      toast.error("Failed to install template");
    } finally {
      setInstallingId("");
    }
  }

  async function handleDownload(item) {
    setDownloadingId(item.id);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${item.id}/download`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to download template");
      }

      const fallbackName = `${item.slug || item.name || "nora-template"}.nora-template.json`;
      await downloadResponseAsFile(res, fallbackName);
      toast.success("Template downloaded");
      loadMarketplace();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to download template");
    } finally {
      setDownloadingId("");
    }
  }

  async function handleReport() {
    if (!reportItem) return;
    setReportingId(reportItem.id);
    try {
      const res = await fetchWithAuth(`/api/marketplace/${reportItem.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reportReason,
          details: reportDetails.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to report listing");
      }

      toast.success("Listing reported");
      setReportItem(null);
      setReportReason("spam");
      setReportDetails("");
      loadMarketplace();
    } catch (error) {
      console.error(error);
      toast.error(error.message || "Failed to report listing");
    } finally {
      setReportingId("");
    }
  }

  return (
    <Layout>
      <div className="flex flex-col gap-8 sm:gap-10 w-full">
        <header className="relative p-8 sm:p-12 md:p-16 rounded-2xl sm:rounded-[2.5rem] md:rounded-[3.5rem] bg-slate-900 overflow-hidden shadow-2xl shadow-blue-500/10 flex flex-col items-start gap-6 border border-white/5">
          <div className="relative z-10 flex flex-col gap-4 max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-widest leading-none mb-2">
              <Sparkles size={12} className="fill-current" />
              Nora Marketplace
            </div>
            <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black text-white tracking-tight leading-none">
              Install presets, browse community templates, and track your own shared agents.
            </h1>
            <p className="text-slate-400 font-medium text-lg leading-relaxed">
              Platform starter packs stay separated from community submissions. Inspect each template before installing, including the OpenClaw core files that will ship with it.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-5 rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {MARKETPLACE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => selectTab(tab.id)}
                  className={clsx(
                    "px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-[0.14em] transition-all whitespace-nowrap ring-1",
                    activeTab === tab.id
                      ? "bg-blue-600 text-white ring-blue-500/50"
                      : "bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 ring-slate-200"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              onClick={loadMarketplace}
              className="inline-flex items-center gap-2 self-start rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {activeTab === "my" && (
            <div className="rounded-[1.5rem] border border-blue-100 bg-blue-50 px-5 py-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-700">
                  Publishing
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  Publish from any agent detail page.
                </p>
                <p className="mt-1 text-sm text-blue-700/80">
                  Nora exports template files only, strips wiring and secrets, then submits the listing for admin review.
                </p>
              </div>
              <a
                href="/app/agents"
                className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-600 transition-colors"
              >
                <Share2 size={16} />
                Open Agents
              </a>
            </div>
          )}

          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={clsx(
                  "px-4 py-2 rounded-xl text-xs font-black uppercase tracking-[0.14em] transition-all whitespace-nowrap ring-1",
                  category === cat
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 ring-slate-200"
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mb-16">
          {loading ? (
            <div className="col-span-full h-80 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white border border-slate-200 rounded-[2.5rem] border-dashed">
              <Loader2 size={36} className="animate-spin text-blue-500" />
              <span className="text-sm font-bold uppercase tracking-widest leading-none">
                Loading marketplace
              </span>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="col-span-full h-80 flex flex-col items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 bg-white text-center text-slate-400 px-6">
              <Bot size={36} className="mb-3 opacity-60" />
              <p className="text-sm font-semibold text-slate-600">
                {activeTab === "my"
                  ? "You have not submitted any marketplace listings yet."
                  : "No marketplace listings matched this filter."}
              </p>
            </div>
          ) : activeTab === "my" ? (
            filteredItems.map((item) => (
              <MyListingCard
                key={item.id}
                item={item}
                downloading={downloadingId === item.id}
                onDownload={() => handleDownload(item)}
              />
            ))
          ) : (
            filteredItems.map((item) => (
              <MarketplaceCard
                key={item.id}
                item={item}
                installing={installingId === item.id}
                downloading={downloadingId === item.id}
                reporting={reportingId === item.id}
                onInstall={() => {
                  setSelectedItem(item);
                  setInstallName(item.name || "");
                }}
                onDownload={() => handleDownload(item)}
                onReport={() => {
                  setReportItem(item);
                  setReportReason("spam");
                  setReportDetails("");
                }}
                showReport={activeTab === "community"}
              />
            ))
          )}
        </div>

        <InstallTemplateDialog
          item={selectedItem}
          name={installName}
          loading={!!installingId}
          onCancel={() => {
            if (installingId) return;
            setSelectedItem(null);
          }}
          onConfirm={installAgent}
          onNameChange={setInstallName}
        />

        <ReportListingDialog
          item={reportItem}
          reason={reportReason}
          details={reportDetails}
          loading={!!reportingId}
          onReasonChange={setReportReason}
          onDetailsChange={setReportDetails}
          onCancel={() => {
            if (reportingId) return;
            setReportItem(null);
          }}
          onConfirm={handleReport}
        />
      </div>
    </Layout>
  );
}

function MarketplaceCard({
  item,
  onInstall,
  onDownload,
  onReport,
  showReport,
  installing,
  downloading,
  reporting,
}) {
  const isPreset = item.source_type === "platform";

  return (
    <div className="group bg-white border border-slate-200 rounded-[2.3rem] shadow-sm hover:shadow-2xl hover:shadow-blue-500/10 hover:border-blue-500/20 transition-all duration-500 overflow-hidden flex flex-col p-1">
      <div className="p-7 pb-4 flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div
            className={clsx(
              "w-16 h-16 rounded-[1.4rem] flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 group-hover:-rotate-3",
              isPreset
                ? "bg-blue-50 text-blue-600 shadow-blue-500/10"
                : "bg-emerald-50 text-emerald-600 shadow-emerald-500/10"
            )}
          >
            {isPreset ? <ShieldCheck size={30} strokeWidth={2.4} /> : <Users size={30} strokeWidth={2.4} />}
          </div>
          <span
            className={clsx(
              "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border",
              isPreset
                ? "bg-slate-100 text-slate-700 border-slate-200"
                : "bg-emerald-50 text-emerald-700 border-emerald-200"
            )}
          >
            {isPreset ? "Preset" : "Community"}
          </span>
        </div>

        <div className="space-y-2">
          <h3 className="text-xl font-black text-slate-900 leading-tight group-hover:text-blue-600 transition-colors">
            {item.name}
          </h3>
          <p className="text-sm text-slate-500 font-medium leading-relaxed line-clamp-3">
            {item.description}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
          <span>{item.category || "General"}</span>
          <span>&bull;</span>
          <span>v{item.current_version || 1}</span>
          {!isPreset && (
            <>
              <span>&bull;</span>
              <span>{item.owner_name || item.owner_email || "Community"}</span>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <TemplateInfoPill
            icon={Layers3}
            label="Core Files"
            value={`${item.template?.presentRequiredCoreCount || 0}/${item.template?.requiredCoreCount || 7}`}
          />
          <TemplateInfoPill
            icon={FileText}
            label="Files"
            value={`${item.template?.fileCount || 0}`}
          />
          <TemplateInfoPill
            icon={Bot}
            label="Sandbox"
            value={item.defaults?.sandbox || "standard"}
          />
          <TemplateInfoPill
            icon={ShieldCheck}
            label="Specs"
            value={`${item.defaults?.vcpu || 2} vCPU / ${Math.round((item.defaults?.ram_mb || 2048) / 1024)} GB`}
          />
        </div>
      </div>

      <div className="px-7 py-4 flex items-center justify-between border-t border-slate-100 mt-2">
        <div className="flex items-center gap-4 text-slate-500">
          <div className="flex items-center gap-1 font-bold">
            <Bot size={14} />
            <span className="text-xs">{formatCount(item.installs)}</span>
          </div>
          <div className="flex items-center gap-1 font-bold">
            <ArrowDownToLine size={14} />
            <span className="text-xs">{formatCount(item.downloads)}</span>
          </div>
        </div>
        <div className="text-sm font-black text-slate-900 tracking-tight leading-none bg-slate-50 px-3 py-2 rounded-xl border border-slate-100 shadow-sm">
          {item.price || "Free"}
        </div>
      </div>

      <div className="p-4 pt-2 mt-auto flex flex-col gap-2">
        <a
          href={`/app/marketplace/${item.id}`}
          className="inline-flex items-center justify-between gap-2 px-4 py-3 bg-white hover:bg-slate-50 border border-slate-200 transition-all text-sm font-bold text-slate-800 rounded-2xl"
        >
          View Details
          <ChevronRight size={16} />
        </a>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onDownload}
            disabled={downloading}
            className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 transition-all text-sm font-bold text-slate-800 rounded-2xl disabled:opacity-50"
          >
            {downloading ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />}
            Download
          </button>
          <button
            onClick={onInstall}
            disabled={installing}
            className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-slate-900 hover:bg-blue-600 border border-slate-800 hover:border-blue-500 transition-all text-sm font-bold text-white rounded-2xl shadow-lg disabled:opacity-50"
          >
            {installing ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Install
          </button>
        </div>
        {showReport && (
          <button
            onClick={onReport}
            disabled={reporting}
            className="col-span-2 inline-flex items-center justify-center gap-2 px-4 py-3 bg-white hover:bg-red-50 border border-slate-200 hover:border-red-200 transition-all text-sm font-bold text-slate-700 hover:text-red-700 rounded-2xl disabled:opacity-50"
          >
            {reporting ? <Loader2 size={16} className="animate-spin" /> : <Flag size={16} />}
            Report Listing
          </button>
        )}
      </div>
    </div>
  );
}

function MyListingCard({ item, onDownload, downloading }) {
  const statusClass =
    STATUS_STYLES[item.status] || "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <div className="bg-white border border-slate-200 rounded-[2.3rem] shadow-sm overflow-hidden flex flex-col p-6 gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-xl font-black text-slate-900">{item.name}</h3>
            <span className={clsx("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border", statusClass)}>
              {String(item.status || "unknown").replace(/_/g, " ")}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-500 leading-relaxed">
            {item.description || "No description provided."}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Version
          </p>
          <p className="text-lg font-black text-slate-900">
            v{item.current_version || 1}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Category
          </p>
          <p className="mt-1 font-semibold text-slate-900">{item.category || "General"}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Price
          </p>
          <p className="mt-1 font-semibold text-slate-900">{item.price || "Free"}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Installs
          </p>
          <p className="mt-1 font-semibold text-slate-900">{formatCount(item.installs)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Downloads
          </p>
          <p className="mt-1 font-semibold text-slate-900">{formatCount(item.downloads)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Core Files
          </p>
          <p className="mt-1 font-semibold text-slate-900">
            {item.template?.presentRequiredCoreCount || 0}/{item.template?.requiredCoreCount || 7}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
            Files
          </p>
          <p className="mt-1 font-semibold text-slate-900">{item.template?.fileCount || 0}</p>
        </div>
      </div>

      {item.review_notes && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">
            Review Note
          </p>
          <p className="mt-2">{item.review_notes}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-auto">
        <a
          href={`/app/marketplace/${item.id}`}
          className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-white hover:bg-slate-50 border border-slate-200 text-sm font-bold text-slate-800 rounded-2xl transition-colors"
        >
          <ChevronRight size={16} />
          Manage Listing
        </a>
        <button
          onClick={onDownload}
          disabled={downloading}
          className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-slate-900 hover:bg-blue-600 text-sm font-bold text-white rounded-2xl shadow-lg transition-colors disabled:opacity-50"
        >
          {downloading ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />}
          Download Template
        </button>
        {item.source_agent_id && (
          <a
            href={`/app/agents/${item.source_agent_id}`}
            className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-white hover:bg-slate-50 border border-slate-200 text-sm font-bold text-slate-800 rounded-2xl transition-colors"
          >
            <ExternalLink size={16} />
            Open Source Agent
          </a>
        )}
      </div>
    </div>
  );
}

function TemplateInfoPill({ icon: Icon, label, value }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon size={14} />
        <p className="text-[10px] font-black uppercase tracking-[0.16em]">
          {label}
        </p>
      </div>
      <p className="mt-2 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}

function InstallTemplateDialog({ item, name, loading, onCancel, onConfirm, onNameChange }) {
  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Plus size={18} className="text-blue-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">Install Template</h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              {item.name} will be turned into a new queued agent in your fleet.
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 transition-colors" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <p className="text-xs font-black uppercase tracking-widest text-slate-500">Template</p>
          <p className="text-base font-bold text-slate-900 mt-1">{item.name}</p>
          <p className="text-sm text-slate-500 mt-2">{item.description}</p>
        </div>

        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">New Agent Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-700 rounded-xl transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !name.trim()}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Install
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportListingDialog({
  item,
  reason,
  details,
  loading,
  onReasonChange,
  onDetailsChange,
  onCancel,
  onConfirm,
}) {
  if (!item) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-lg w-full p-6 space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Flag size={18} className="text-red-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-slate-900">Report Listing</h3>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">
              Flag {item.name} for admin review.
            </p>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-600 transition-colors" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Reason</label>
          <select
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500 bg-white"
          >
            {REPORT_REASONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-[10px] text-slate-400 font-bold uppercase tracking-widest block mb-1">Details</label>
          <textarea
            value={details}
            onChange={(e) => onDetailsChange(e.target.value)}
            rows={4}
            className="w-full text-sm border border-slate-200 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            placeholder="Add context that helps the admin review this submission."
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-sm font-bold text-slate-700 rounded-xl transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-sm font-bold text-white rounded-xl transition-all shadow-lg shadow-red-500/20 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Flag size={14} />}
            Submit Report
          </button>
        </div>
      </div>
    </div>
  );
}
