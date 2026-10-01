import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/web/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/cli/main.ts", "src/web/main.tsx"],
      reporter: ["text", "json", "json-summary"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
