import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  basePath: "/app",
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
  },
};

export default nextConfig;
