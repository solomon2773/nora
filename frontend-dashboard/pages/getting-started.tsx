import Layout from "../components/layout/Layout";
import ActivationChecklist from "../components/onboarding/ActivationChecklist";
import { ArrowRight, Bot, CheckCircle2, FolderKanban, KeyRound, Rocket, Shield } from "lucide-react";

const launchSignals = [
  "You can create or sign in to an operator account without friction.",
  "A provider key is stored once and available for agent sync.",
  "The first OpenClaw agent deploys through the default Docker path.",
  "Chat, logs, and terminal are all reachable from the same operator surface.",
];

const bestFit = [
  {
    icon: Shield,
    title: "Internal AI platform teams",
    desc: "Use Nora as the operator layer around self-hosted OpenClaw infrastructure instead of building internal glue from scratch.",
  },
  {
    icon: Bot,
    title: "Technical product teams",
    desc: "Give OpenClaw-backed products a more credible operator surface with deployment, key sync, and observability already packaged together.",
  },
  {
    icon: FolderKanban,
    title: "Ops-minded founders",
    desc: "Keep infrastructure, networking, and provider credentials under your own control from day one.",
  },
];

export default function GettingStartedPage() {
  return (
    <Layout>
      <div className="max-w-6xl mx-auto flex flex-col gap-8 sm:gap-10 pb-12">
        <section className="grid xl:grid-cols-[1.2fr,0.8fr] gap-6 items-start">
          <div className="bg-slate-950 text-white rounded-[2rem] p-6 sm:p-8 border border-slate-800 shadow-2xl">
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-blue-300 mb-3">Getting started</p>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight leading-tight mb-4">
              Bring Nora online like a production operator platform
            </h1>
            <p className="text-slate-300 leading-relaxed max-w-2xl">
              Nora is designed to move a team from setup to live operations quickly: connect one provider, deploy one OpenClaw agent, and run the operator workflow from inside the product.
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mt-8">
              {launchSignals.map((item) => (
                <div key={item} className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 flex items-start gap-3">
                  <CheckCircle2 size={18} className="text-emerald-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-slate-300 leading-relaxed">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-[2rem] p-6 sm:p-8 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 mb-4">Fast self-hosted launch path</p>
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                  <KeyRound size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">1. Add one provider key</p>
                  <p className="text-sm text-slate-500 mt-1">Start in Settings. A single working provider is enough to bring the deployment workflow online.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                  <Rocket size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">2. Deploy your first OpenClaw agent</p>
                  <p className="text-sm text-slate-500 mt-1">Open Deploy and choose one enabled backend for your first live runtime.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-2xl bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
                  <Bot size={18} />
                </div>
                <div>
                  <p className="text-sm font-black text-slate-900">3. Verify the runtime immediately</p>
                  <p className="text-sm text-slate-500 mt-1">Open the agent page and confirm chat, logs, and terminal access before expanding the deployment.</p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 mt-8">
              <a href="/app/settings" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 text-white px-4 py-3 text-sm font-bold hover:bg-blue-700 transition-all">
                Start in Settings <ArrowRight size={15} />
              </a>
              <a href="/app/deploy" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-all">
                Deploy first agent <ArrowRight size={15} />
              </a>
            </div>
          </div>
        </section>

        <ActivationChecklist
          title="Self-hosted launch checklist"
          subtitle="The checklist below keeps the product workflow aligned: operator setup, first deploy, then live runtime checks inside Nora."
        />

        <section className="grid lg:grid-cols-3 gap-5">
          {bestFit.map((item) => (
            <div key={item.title} className="bg-white border border-slate-200 rounded-3xl p-6 shadow-sm">
              <div className="w-11 h-11 rounded-2xl bg-slate-950 text-white flex items-center justify-center mb-4">
                <item.icon size={18} />
              </div>
              <h2 className="text-lg font-black text-slate-900 mb-2">{item.title}</h2>
              <p className="text-sm text-slate-500 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </section>
      </div>
    </Layout>
  );
}
