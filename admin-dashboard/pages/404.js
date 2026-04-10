import Link from "next/link";
import { ArrowLeft, Ghost } from "lucide-react";

export default function Admin404() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 text-white">
      <Ghost size={64} className="mb-6 text-slate-700" />
      <h1 className="mb-2 text-6xl font-black">404</h1>
      <p className="mb-8 text-center text-lg text-slate-400">
        This admin page doesn&apos;t exist.
      </p>
      <Link
        href="/"
        className="flex items-center gap-2 rounded-2xl bg-red-600 px-6 py-3 text-sm font-bold transition-all hover:bg-red-700"
      >
        <ArrowLeft size={16} />
        Back to Admin
      </Link>
    </div>
  );
}
