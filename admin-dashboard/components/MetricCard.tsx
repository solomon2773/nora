import Link from "next/link";
import { clsx } from "clsx";

const TONES = {
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  orange: "bg-orange-50 text-orange-700 ring-orange-100",
  purple: "bg-violet-50 text-violet-700 ring-violet-100",
  red: "bg-red-50 text-red-700 ring-red-100",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
};

export default function MetricCard({
  label,
  value,
  icon: Icon,
  tone = "blue",
  href = null,
  caption = null,
}) {
  const card = (
    <div className="rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg">
      <div
        className={clsx(
          "mb-5 flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ring-inset",
          TONES[tone] || TONES.blue
        )}
      >
        <Icon size={20} />
      </div>
      <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-3xl font-black tracking-tight text-slate-950">
        {value}
      </p>
      {caption ? (
        <p className="mt-2 text-sm font-medium text-slate-500">{caption}</p>
      ) : null}
    </div>
  );

  if (!href) return card;

  return (
    <Link href={href} className="block">
      {card}
    </Link>
  );
}
