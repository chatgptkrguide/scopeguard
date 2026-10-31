import { defineConfig } from "@playwright/test";

const NO_PAYPAL_PORT = 3210;
const PAYPAL_PORT = 3211;

// Browser tests run against one production build (`pnpm e2e` builds first) on fresh throwaway
// databases, using the installed Chrome. Each server migrates its empty database itself at startup,
// so every run also checks startup migrations. Phase 1 checks run on a server without PayPal keys;
// PayPal checks run on a second server that reads the sandbox keys from .env.local.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  use: { channel: "chrome", headless: true },
  projects: [
    { name: "no-paypal", testMatch: /(smoke|p1)\.spec\.ts/, use: { baseURL: `http://localhost:${NO_PAYPAL_PORT}` } },
    { name: "paypal", testMatch: /p2.*\.spec\.ts/, use: { baseURL: `http://localhost:${PAYPAL_PORT}` } },
  ],
  webServer: [
    {
      command: `rm -f data/e2e.db && pnpm start --port ${NO_PAYPAL_PORT}`,
      url: `http://localhost:${NO_PAYPAL_PORT}`,
      env: { DATABASE_URL: "file:data/e2e.db", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_WEBHOOK_ID: "" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `rm -f data/e2e-paypal.db && pnpm start --port ${PAYPAL_PORT}`,
      url: `http://localhost:${PAYPAL_PORT}`,
      env: { DATABASE_URL: "file:data/e2e-paypal.db" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
