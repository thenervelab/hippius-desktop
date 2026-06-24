import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      // Non-gating on purpose: this is a visibility tool, not a merge gate.
      // A low global number is correct here — most .tsx files are presentational
      // and their risky logic lives in Rust — so a hard threshold would only
      // pressure mock-tautology tests. Ratchet a floor on logic scopes
      // (lib/utils, lib/upload-feed, lib/tray, lib/hooks) separately if desired.
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text-summary", "html"],
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "app/**/__tests__/**",
        "app/**/*.test.{ts,tsx}",
        "app/**/*.d.ts",
        "app/lib/test-utils/**",
        "app/e2e/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "app/components"),
      "@/lib": path.resolve(__dirname, "app/lib"),
      "@/services": path.resolve(__dirname, "app/lib/services"),
      "@/app": path.resolve(__dirname, "app"),
    },
  },
});
