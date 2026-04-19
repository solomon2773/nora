import Link from "next/link";
import { ArrowLeft, Ghost, Zap } from "lucide-react";

export default function Marketing404() {
  return (
    <div className="min-h-screen bg-[#0f172a] text-white font-sans flex flex-col items-center justify-center">
      <Ghost size={64} className="text-slate-700 mb-6" />
      <h1 className="text-6xl font-black mb-2">404</h1>
      <p className="text-lg text-slate-400 mb-8">This page doesn&apos;t exist or has been moved.</p>
      <Link
        href="/"
        className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-sm font-bold rounded-xl transition-all"
      >
        <ArrowLeft size={16} />
        Back to Home
      </Link>
    </div>
  );
}
