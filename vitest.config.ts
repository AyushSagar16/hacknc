import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: "forks",
    globalSetup: ["test/helpers/global-setup.ts"],
    env: { LOG_LEVEL: "silent", LLM_MODE: "fake", IMESSAGE_MODE: "sim" },
  },
});
