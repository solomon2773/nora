import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  DollarSign,
  Loader2,
  Save,
  Search,
} from "lucide-react";
import CostBreakdown from "../../../components/CostBreakdown";
import Layout from "../../../components/layout/Layout";
import { useToast } from "../../../components/Toast";
import { useI18n } from "../../../lib/i18n";
import {
  type WorkspaceBudget,
  type WorkspaceCost,
  deleteBudget,
  getWorkspaceCost,
  listBudgets,
  upsertBudget,
} from "../../../lib/workspaceClient";

const PERIOD_DAYS_OPTIONS = [7, 30, 90];
const BUDGET_PERIODS: Array<"daily" | "weekly" | "monthly"> = ["daily", "weekly", "monthly"];

function formatUsd(value?: number | null): string {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatNumber(value?: number | null): string {
  return Number(value || 0).toLocaleString();
}

function agentMatchesSearch(agent: WorkspaceCost["perAgent"][number], query: string) {
  if (!query) return true;
  const models = agent.cost_details?.tokens?.models || [];
  return [
    agent.agentName,
    agent.agentId,
    agent.status,
    agent.runtime_family,
    agent.backend_type,
    ...models.flatMap((model) => [model.model, model.provider, model.rate_source]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export default function WorkspaceCostPage() {
  const router = useRouter();
  const workspaceId = typeof router.query.id === "string" ? router.query.id : null;
  const { t } = useI18n();
  const toast = useToast();

  const [periodDays, setPeriodDays] = useState(30);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [search, setSearch] = useState("");
  const [cost, setCost] = useState<WorkspaceCost | null>(null);
  const [budgets, setBudgets] = useState<WorkspaceBudget[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetPeriod, setBudgetPeriod] = useState<"daily" | "weekly" | "monthly">("monthly");
  const [budgetLimit, setBudgetLimit] = useState("");
  const [budgetThreshold, setBudgetThreshold] = useState("80");
  const usingCustomRange = Boolean(periodStart || periodEnd);
  const searchQuery = search.trim().toLowerCase();

  async function reload() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [costRes, budgetsRes] = await Promise.all([
        getWorkspaceCost(
          workspaceId,
          usingCustomRange ? { periodStart, periodEnd } : { periodDays },
        ),
        listBudgets(workspaceId),
      ]);
      setCost(costRes);
      setBudgets(budgetsRes);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load cost data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, [workspaceId, periodDays, periodStart, periodEnd]);

  async function handleSaveBudget(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || !budgetLimit) return;
    setSavingBudget(true);
    try {
      await upsertBudget(workspaceId, {
        period: budgetPeriod,
        limitUsd: Number(budgetLimit),
        softThresholdPct: Number(budgetThreshold) || 80,
      });
      setBudgetLimit("");
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to save budget");
    } finally {
      setSavingBudget(false);
    }
  }

  async function handleDeleteBudget(budget: WorkspaceBudget) {
    if (!workspaceId) return;
    if (!confirm(`Remove the ${budget.period} budget?`)) return;
    try {
      await deleteBudget(workspaceId, budget.id);
      await reload();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete budget");
    }
  }

  const sortedAgents = useMemo(() => {
    if (!cost) return [];
    return [...cost.perAgent]
      .filter((agent) => agentMatchesSearch(agent, searchQuery))
      .sort((a, b) => b.total_cost - a.total_cost);
  }, [cost, searchQuery]);

  return (
    <Layout>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 sm:gap-6 p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[2rem] md:rounded-[3rem] bg-white border border-slate-200 shadow-2xl shadow-slate-200/50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center justify-center text-emerald-600 shadow-sm">
              <DollarSign size={28} strokeWidth={2.5} />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">
                {t("Cost dashboard")}
              </h1>
              <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest opacity-80 leading-none">
                {workspaceId}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {PERIOD_DAYS_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => {
                  setPeriodStart("");
                  setPeriodEnd("");
                  setPeriodDays(days);
                }}
                className={`text-xs font-bold px-3 py-2 rounded-xl ${
                  !usingCustomRange && periodDays === days
                    ? "bg-blue-600 text-white"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </header>

        <section className="grid gap-3 rounded-[2rem] border border-slate-200 bg-white p-4 shadow-sm lg:grid-cols-[1fr_auto] lg:items-end">
          <label className="flex min-w-0 flex-col gap-2">
            <span className="text-xs font-black uppercase text-slate-400">Search</span>
            <span className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <Search size={16} className="shrink-0 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Agent, model, or provider"
                className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400"
              />
            </span>
          </label>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="flex flex-col gap-2">
              <span className="text-xs font-black uppercase text-slate-400">Start date</span>
              <span className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <CalendarDays size={16} className="shrink-0 text-slate-400" />
                <input
                  type="date"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                  className="bg-transparent text-sm font-semibold text-slate-900 outline-none"
                />
              </span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-xs font-black uppercase text-slate-400">End date</span>
              <span className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <CalendarDays size={16} className="shrink-0 text-slate-400" />
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                  className="bg-transparent text-sm font-semibold text-slate-900 outline-none"
                />
              </span>
            </label>
            <button
              type="button"
              onClick={() => {
                setPeriodStart("");
                setPeriodEnd("");
              }}
              className="rounded-2xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50"
            >
              Clear dates
            </button>
          </div>
        </section>

        {cost?.crossings && cost.crossings.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-[2.5rem] p-6 shadow-sm flex items-start gap-3">
            <AlertTriangle size={20} className="text-amber-600 mt-1 shrink-0" />
            <div className="flex-1">
              <h3 className="text-sm font-black text-slate-900 mb-1">{t("Budget alerts")}</h3>
              <ul className="text-xs text-slate-700 space-y-1">
                {cost.crossings.map((crossing, i) => (
                  <li key={i}>
                    {crossing.bucket === "hard" ? "🚨" : "⚠️"} {crossing.budget.period} budget at{" "}
                    {crossing.pct}% — {formatUsd(crossing.currentUsd)} of{" "}
                    {formatUsd(crossing.budget.limitUsd)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-2">{t("Total spend")}</h2>
          {loading ? (
            <div className="h-24 flex items-center justify-center text-slate-400">
              <Loader2 size={24} className="animate-spin" />
            </div>
          ) : (
            <div className="flex items-baseline gap-3">
              <span className="text-4xl md:text-5xl font-black text-slate-900">
                {formatUsd(cost?.totalUsd || 0)}
              </span>
              <span className="text-xs text-slate-500 font-bold">
                {usingCustomRange
                  ? `${cost?.periodStart?.slice(0, 10) || "start"} to ${
                      cost?.periodEnd?.slice(0, 10) || "now"
                    }`
                  : `${t("over the last")} ${periodDays} ${t("days")}`}
              </span>
            </div>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Per-agent breakdown")}</h2>
          {sortedAgents.length === 0 ? (
            <div className="text-sm text-slate-500 py-8 text-center">
              {searchQuery ? "No agents match this search." : t("No agents in this workspace.")}
              {!searchQuery ? (
                <div className="mt-4">
                  <Link
                    href={`/workspaces/${workspaceId}/agents`}
                    className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-blue-700"
                  >
                    {t("Assign agents")}
                    <ArrowUpRight size={15} />
                  </Link>
                </div>
              ) : null}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {sortedAgents.map((agent) => (
                <li key={agent.agentId} className="py-3">
                  <Link
                    href={`/agents/${agent.agentId}`}
                    className="flex items-center justify-between gap-4 rounded-xl px-2 py-2 hover:bg-slate-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-slate-900 truncate">
                        {agent.agentName}
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatUsd(agent.token_cost)} token cost ·{" "}
                        {formatNumber(agent.total_tokens)} tokens
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-2 text-sm font-black text-slate-900">
                      {formatUsd(agent.total_cost)}
                      <ArrowUpRight size={14} className="text-slate-400" />
                    </span>
                  </Link>
                  <CostBreakdown agent={agent} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-[2.5rem] p-8 shadow-sm">
          <h2 className="text-lg font-black text-slate-900 mb-4">{t("Budgets")}</h2>
          <form
            onSubmit={handleSaveBudget}
            className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end mb-6"
          >
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {t("Period")}
              </span>
              <select
                value={budgetPeriod}
                onChange={(e) => setBudgetPeriod(e.target.value as typeof budgetPeriod)}
                className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
              >
                {BUDGET_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(p.charAt(0).toUpperCase() + p.slice(1))}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {t("Limit (USD)")}
              </span>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="100.00"
                className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
                value={budgetLimit}
                onChange={(e) => setBudgetLimit(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                {t("Soft alert (%)")}
              </span>
              <input
                type="number"
                min="0"
                max="100"
                placeholder="80"
                className="w-24 px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-bold text-slate-900 outline-none"
                value={budgetThreshold}
                onChange={(e) => setBudgetThreshold(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={savingBudget}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold px-5 py-3 rounded-2xl shadow-lg shadow-blue-500/30 active:scale-95 disabled:opacity-50"
            >
              {savingBudget ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {t("Save budget")}
            </button>
          </form>
          {budgets.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {budgets.map((budget) => (
                <li key={budget.id} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-bold text-slate-900">
                      {t(budget.period.charAt(0).toUpperCase() + budget.period.slice(1))} ·{" "}
                      {formatUsd(budget.limitUsd)}
                    </div>
                    <div className="text-xs text-slate-500">
                      {t("Soft alert at")} {budget.softThresholdPct}%
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteBudget(budget)}
                    className="text-xs font-bold px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-red-50 hover:text-red-600 text-slate-700"
                  >
                    {t("Remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Layout>
  );
}
