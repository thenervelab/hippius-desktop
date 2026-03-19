import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
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
