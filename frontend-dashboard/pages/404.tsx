import Link from "next/link";
import { ArrowLeft, Ghost } from "lucide-react";
import Layout from "../components/layout/Layout";

export default function Custom404() {
  return (
    <Layout>
      <div className="flex flex-col items-center justify-center h-[60vh] text-center">
        <Ghost size={64} className="text-slate-700 mb-6" />
        <h1 className="text-6xl font-black text-white mb-2">404</h1>
        <p className="text-lg text-slate-400 mb-8">This page doesn&apos;t exist or has been moved.</p>
        <Link
          href="/dashboard"
          className="flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-sm font-bold text-white rounded-xl transition-all"
        >
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
      </div>
    </Layout>
  );
}
