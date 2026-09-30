import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // PGlite instances are created per test file; keep files isolated.
    pool: "forks",
    testTimeout: 20_000,
  },
});
