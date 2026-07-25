import { useId, type FormEvent } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

type Props = {
  title: string;
  description: string;
  expectedValues: string[];
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
  danger?: boolean;
};

export default function DangerConfirmPanel({
  title,
  description,
  expectedValues,
  value,
  onChange,
  onCancel,
  onConfirm,
  busy,
  confirmLabel,
  danger = false,
}: Props) {
  const inputId = useId();
  const normalized = value.trim();
  const confirmed = expectedValues.some((entry) => normalized === entry);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmed && !busy) onConfirm();
  }

  return (
    <form
      onSubmit={submit}
      className={`rounded-[1.5rem] border p-5 ${
        danger ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <ShieldAlert
          size={20}
          className={`mt-0.5 shrink-0 ${danger ? "text-red-700" : "text-amber-700"}`}
        />
        <div className="min-w-0 flex-1">
          <h3 className={`font-black ${danger ? "text-red-950" : "text-amber-950"}`}>{title}</h3>
          <p
            className={`mt-1 text-sm font-medium leading-relaxed ${
              danger ? "text-red-800" : "text-amber-800"
            }`}
          >
            {description}
          </p>
          <label htmlFor={inputId} className="mt-4 block">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-600">
              Type {expectedValues.map((entry) => `“${entry}”`).join(" or ")} to confirm
            </span>
            <input
              id={inputId}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoComplete="off"
              className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-950 outline-none focus:border-brand-cyan focus:ring-4 focus:ring-brand-cyan/20"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!confirmed || busy}
              className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${
                danger
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "bg-amber-500 text-brand-ink hover:bg-amber-400"
              }`}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : null}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
