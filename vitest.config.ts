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
      // NO global threshold on purpose: most .tsx files are presentational and
      // their risky logic lives in Rust, so a global floor would only pressure
      // mock-tautology tests. Instead we ratchet per-scope floors on the four
      // logic-bearing directories (the data-projection layer history shows
      // breaking on feature additions). The floors below are set ~1 point under
      // the measured coverage at the time of writing — they LOCK the current
      // level (a regression that drops a scope below its floor fails
      // `pnpm test:coverage`, which CI runs) and are meant to be ratcheted UP as
      // coverage grows, never down. Caveat: these are aggregate-per-scope, so a
      // single new untested file in a large scope (utils/hooks) may not move the
      // number enough to trip — they catch real regressions and set the ratchet
      // baseline, not every individual gap. Re-measure with
      // `pnpm test:coverage` before raising a floor.
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
      thresholds: {
        "app/lib/utils/**": { statements: 33, branches: 84, functions: 49, lines: 33 },
        "app/lib/upload-feed/**": { statements: 96, branches: 80, functions: 95, lines: 96 },
        "app/lib/tray/**": { statements: 82, branches: 83, functions: 65, lines: 82 },
        "app/lib/hooks/**": { statements: 35, branches: 71, functions: 62, lines: 35 },
      },
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
