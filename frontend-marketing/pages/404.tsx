import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import SeoHead from "../components/SeoHead";
import { useI18n } from "../lib/i18n";

export default function Marketing404() {
  const { t } = useI18n();
  return (
    <>
      <SeoHead
        title="Page Not Found | Nora"
        description="The requested Nora page could not be found."
        path="/404"
        noIndex
      />
      <div className="site-shell flex min-h-screen flex-col items-center justify-center px-4 text-center font-sans text-brand-ink">
        <img
          src="/logo-mark.png"
          alt="Nora"
          width={72}
          height={72}
          className="mb-6 h-[72px] w-[72px]"
        />
        <h1 className="mb-2 text-6xl font-black">404</h1>
        <p className="mb-8 text-lg text-slate-600">
          {t("This page doesn't exist or has been moved.")}
        </p>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl bg-brand-cyan px-6 py-3 text-sm font-black text-brand-ink shadow-lg shadow-brand-cyan/25 transition-all hover:-translate-y-0.5"
        >
          <ArrowLeft size={16} />
          {t("Back to Home")}
        </Link>
      </div>
    </>
  );
}
