import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      // server-only throws on import outside React Server Components; tests run server modules directly.
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)) },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Real-sandbox checks run only through `pnpm accept:sandbox`.
    exclude: ["**/node_modules/**", "src/**/*.sandbox.accept.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
