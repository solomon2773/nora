import { ArrowUpRight, Loader2, Server } from "lucide-react";
import { REMOTE_DOCKER_GUIDE_URL } from "../../lib/remoteHosts";
import type { PlatformMode } from "../../lib/platform";

export default function RemoteHostsAvailability({ mode }: { mode: PlatformMode }) {
  if (mode === "loading") {
    return (
      <div className="flex min-h-72 items-center justify-center rounded-[2rem] border border-slate-200 bg-white text-sm font-semibold text-slate-500 shadow-sm">
        <Loader2 size={20} className="mr-2 animate-spin text-brand-ink" />
        Verifying self-hosted mode…
      </div>
    );
  }

  const hosted = mode === "paas";
  return (
    <section className="mx-auto max-w-3xl rounded-[2rem] border border-brand-cyan/35 bg-white p-6 shadow-sm sm:p-8">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-cyan/20 text-brand-ink">
        <Server size={24} />
      </span>
      <p className="mt-5 text-[11px] font-black uppercase tracking-[0.2em] text-brand-ink/55">
        Credentials unavailable
      </p>
      <h1 className="mt-2 text-2xl font-black tracking-tight text-brand-ink">
        {hosted ? "Platform hosts require self-hosted Nora" : "Platform mode is unverified"}
      </h1>
      <p className="mt-3 text-sm font-medium leading-relaxed text-slate-600">
        {hosted
          ? "Hosted Nora does not accept or use customer SSH credentials. Run Nora on infrastructure you control before registering a platform-managed Remote Docker host."
          : "Nora could not verify this installation as self-hosted. Credential fields and every Remote Host mutation remain hidden until the public platform configuration endpoint reports selfhosted mode."}
      </p>
      <a
        href={REMOTE_DOCKER_GUIDE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-brand-cyan px-4 py-3 text-sm font-black text-brand-ink transition hover:bg-brand-cyan/80 focus:outline-none focus:ring-4 focus:ring-brand-cyan/30"
      >
        Read Remote Docker documentation
        <ArrowUpRight size={15} />
      </a>
    </section>
  );
}
