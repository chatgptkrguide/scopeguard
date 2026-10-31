import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@/server/health";
import { GET as live } from "./live/route";
import { GET as deep } from "./route";

// The checks themselves are tested in src/server/health.test.ts; this covers how the routes answer.
const checks = vi.hoisted(() => ({
  report: { status: "ok", database: "ok", paypal: "ok", webhook: "missing", commit: null } as HealthReport,
  database: "ok" as "ok" | "fail",
}));

vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/server/health", () => ({
  liveHealthDeps: () => ({}),
  checkHealth: async () => checks.report,
  checkLiveDatabase: async () => checks.database,
}));

describe("헬스 체크 라우트", () => {
  it("/api/health는 status ok면 200, 아니면 503이고 캐시하지 않는다", async () => {
    checks.report = { status: "ok", database: "ok", paypal: "ok", webhook: "missing", commit: "10a644e" };
    const ok = await deep();
    checks.report = { status: "fail", database: "ok", paypal: "fail", webhook: "missing", commit: null };
    const failing = await deep();

    expect([ok.status, failing.status]).toEqual([200, 503]);
    expect(await ok.json()).toEqual({ status: "ok", database: "ok", paypal: "ok", webhook: "missing", commit: "10a644e" });
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("/api/health/live는 DB만 보고 200 또는 503이다", async () => {
    checks.database = "ok";
    const ok = await live();
    checks.database = "fail";
    const failing = await live();

    expect([ok.status, failing.status]).toEqual([200, 503]);
    expect([await ok.json(), await failing.json()]).toEqual([{ database: "ok" }, { database: "fail" }]);
    expect(failing.headers.get("cache-control")).toBe("no-store");
  });
});
