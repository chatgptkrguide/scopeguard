import { defineConfig } from "@playwright/test";

const PORT = 3210;

// Browser tests run against a production build on a throwaway database, using the installed Chrome.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: `pnpm db:migrate && pnpm build && pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    env: { DATABASE_URL: "file:data/e2e.db" },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
