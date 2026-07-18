import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      exclude: ["src/cli.ts", "src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 78,
        statements: 76,
      },
    },
  },
});
