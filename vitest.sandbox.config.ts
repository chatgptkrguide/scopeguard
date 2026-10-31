import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Acceptance checks against the real PayPal sandbox with the keys in .env.local.
// Never part of `pnpm check`; run with `pnpm accept:sandbox`.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.sandbox.accept.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
