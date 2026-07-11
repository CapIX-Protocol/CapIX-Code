import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*"],
      exclude: ["src/**/*.test.*"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
