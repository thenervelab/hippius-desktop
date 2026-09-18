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
    // The release lane this build is for, forwarded from the SAME variable
    // Rust's `release_channel.rs` reads. The frontend build runs inside
    // `tauri build` (`beforeBuildCommand`), so the workflow's one env line
    // reaches both sides and they cannot disagree about which lane a build
    // is. Absent locally and in CI checks, which `parseBuildChannel` treats
    // as production — see `app/lib/buildChannel.ts`.
    //
    // Dropping this line does not fail anything: every channel-gated flag
    // silently falls back to production, so a beta-only feature simply
    // never appears in beta. Pinned by `release_lane_pins.rs`.
    //
    // A `next dev` build with no variable set resolves to STAGING, not
    // production: a developer working on a lane-gated feature has to be able
    // to see it, and telling everyone to export a variable before
    // `pnpm tauri:dev` is a step that gets forgotten and reads as the feature
    // being broken. Keyed on NODE_ENV rather than an npm script so it holds
    // on Windows, where an inline `VAR=x` prefix in a script does not run.
    // `next build` is NODE_ENV=production, so a real build is unaffected.
    RELEASE_CHANNEL:
      process.env.HIPPIUS_RELEASE_CHANNEL ??
      (process.env.NODE_ENV === "development" ? "staging" : ""),
  },

  // Performance settings from next.config.ts
  poweredByHeader: false,
  reactStrictMode: true,
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
        crypto: false,
      };
    }
    // Rewrite node: scheme imports to bare specifiers so fallbacks apply
    config.plugins = config.plugins || [];
    const webpack = require("webpack");
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, "");
      })
    );
    return config;
  },
};

export default nextConfig;
