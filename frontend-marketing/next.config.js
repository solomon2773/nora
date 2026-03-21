/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_PLATFORM_MODE: process.env.PLATFORM_MODE || "selfhosted",
  },
};
module.exports = nextConfig;
