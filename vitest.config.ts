import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["apps/cli/src/testing/setup.ts"],
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/src/testing/**",
        "**/dist/**",
        "**/node_modules/**",
      ],
    },
  },
});
