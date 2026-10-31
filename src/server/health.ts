import "server-only";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb, type Db } from "./db/client";
import { appliedMigrationCount, expectedMigrationCount } from "./db/migrate";
import { env } from "./env";
import { getPayPal, type PayPalClient } from "./paypal/token";

// Health checks. /api/health/live (what Render polls every few seconds) looks at the database only, so a slow PayPal
// sandbox never makes Render restart the app. /api/health (the daily check) also gets a PayPal token. Answers are
// enum values and a short commit only: no error text, debug id, webhook id or key.

export interface HealthReport {
  status: "ok" | "fail"; // ok only when database and paypal are both "ok"
  database: "ok" | "fail"; // SELECT 1 + applied migrations >= bundled journal entries
  paypal: "ok" | "fail" | "not_configured"; // an access token can be had (cached token counts)
  webhook: "configured" | "missing"; // PAYPAL_WEBHOOK_ID set or not; never fails the check (registered after the first deploy)
  commit: string | null; // first 7 characters of RENDER_GIT_COMMIT (the repo is public), null elsewhere
}

export interface HealthDeps {
  db: Db;
  paypal: PayPalClient | null;
  webhookConfigured: boolean;
  commit: string | null;
  nowMs: () => number;
  expectedMigrations: number;
}

const PAYPAL_CHECK_TTL_MS = 60 * 1000;

// The last PayPal answer per client, success or failure, so polling /api/health can't hammer PayPal's token endpoint.
const paypalChecks = new WeakMap<PayPalClient, { at: number; result: "ok" | "fail" }>();

async function checkPayPal(client: PayPalClient, nowMs: () => number): Promise<"ok" | "fail"> {
  const cached = paypalChecks.get(client);
  if (cached && nowMs() - cached.at < PAYPAL_CHECK_TTL_MS) return cached.result;
  let result: "ok" | "fail";
  try {
    await client.checkToken();
    result = "ok";
  } catch (error) {
    console.error("health check: getting a PayPal token failed", error);
    result = "fail";
  }
  paypalChecks.set(client, { at: nowMs(), result });
  return result;
}

export async function checkDatabase(db: Db, expectedMigrations: number): Promise<"ok" | "fail"> {
  try {
    await db.run(sql`SELECT 1`);
    return (await appliedMigrationCount(db)) >= expectedMigrations ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

// The PayPal part is cached for 60 s, success or failure.
export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const [database, paypal] = await Promise.all([
    checkDatabase(deps.db, deps.expectedMigrations),
    deps.paypal ? checkPayPal(deps.paypal, deps.nowMs) : Promise.resolve("not_configured" as const),
  ]);
  return {
    status: database === "ok" && paypal === "ok" ? "ok" : "fail",
    database,
    paypal,
    webhook: deps.webhookConfigured ? "configured" : "missing",
    commit: deps.commit,
  };
}

// The first seven characters of a git commit id, or null for anything that isn't one.
export function shortCommit(value: string | undefined): string | null {
  return value !== undefined && /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7).toLowerCase() : null;
}

let expected: number | undefined;
// The journal shipped with this build, read once.
function bundledMigrations(): number {
  expected ??= expectedMigrationCount(join(process.cwd(), "drizzle"));
  return expected;
}

export function liveHealthDeps(): HealthDeps {
  return {
    db: getDb(),
    paypal: getPayPal(),
    webhookConfigured: env().PAYPAL_WEBHOOK_ID !== undefined,
    commit: shortCommit(process.env.RENDER_GIT_COMMIT),
    nowMs: Date.now,
    expectedMigrations: bundledMigrations(),
  };
}

// The database-only check Render polls. Any failure, reading the config included, answers "fail".
export async function checkLiveDatabase(): Promise<"ok" | "fail"> {
  try {
    return await checkDatabase(getDb(), bundledMigrations());
  } catch {
    return "fail";
  }
}
