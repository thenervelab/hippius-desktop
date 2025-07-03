// Import the version from package.json
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("./package.json");
import type { Configuration as WebpackConfiguration } from "webpack";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export configuration for Tauri
  output: "export",
  distDir: "out",

  // Fix asset prefix for font loading
  assetPrefix: "/",

  // Environment variables
  env: {
    APP_VERSION: version,
  },

  // Performance settings from next.config.ts
  poweredByHeader: false,
  reactStrictMode: true,
  swcMinify: true,
  compress: true,

  // Image optimization settings
  images: {
    unoptimized: true, // Must be true for static export
  },

  // Empty basePath for static export
  basePath: "",
  webpack: (
    config: WebpackConfiguration,
    { isServer }: { isServer: boolean }
  ) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
      };
    }
    return config;
  },
};

export default nextConfig;
