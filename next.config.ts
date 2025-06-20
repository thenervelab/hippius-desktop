import type { NextConfig } from "next";

const { version } = require('./package.json');

const nextConfig: NextConfig = {
  env: {
    APP_VERSION: version,
  },
  poweredByHeader: false,
  reactStrictMode: true,
  swcMinify: true,
  compress: true,
  images: {
    unoptimized: false,
  },
};

export default nextConfig;
