/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // Disable image optimization since it's not supported with static exports
  images: { unoptimized: true },
  // Disable server components that aren't compatible with static export
  reactStrictMode: true,
  swcMinify: true,
  // To ensure Next.js builds properly for Tauri static bundling
  distDir: 'out',
};

module.exports = nextConfig;
