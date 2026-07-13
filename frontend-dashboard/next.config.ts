import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  basePath: "/app",
  i18n: {
    locales: ["en", "es", "fr", "zh-Hans", "zh-Hant"],
    defaultLocale: "en",
    localeDetection: false,
  },
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
  },
};

export default nextConfig;
