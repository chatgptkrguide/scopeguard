import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, invalidClient, type FakeReply } from "../../test/paypal-fixtures";
import { createDb, type Db } from "./db/client";
import { expectedMigrationCount, runMigrations } from "./db/migrate";
import { parseEnv } from "./env";
import { checkDatabase, checkHealth, shortCommit, type HealthDeps } from "./health";
import { createPayPalClient, paypalConfig } from "./paypal/token";

const TOKEN = "POST /v1/oauth2/token";
const CLIENT_ID = "stand-in-client-id";
const CLIENT_SECRET = "stand-in-client-secret-0123456789";
const config = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET }))!;

describe("헬스 체크", () => {
  let db: Db;
  let clock: number;
  const expectedMigrations = expectedMigrationCount("drizzle");

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    clock = Date.parse("2026-11-01T09:00:00.000Z");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // A PayPal client whose token endpoint answers as scripted (by default: a valid token).
  function paypal(token?: FakeReply | readonly FakeReply[]) {
    const fake = fakeFetch(token === undefined ? {} : { [TOKEN]: token });
    return { ...fake, client: createPayPalClient(config, { fetch: fake.fetch }) };
  }

  const deps = (overrides: Partial<HealthDeps> = {}): HealthDeps => ({
    db,
    paypal: paypal().client,
    webhookConfigured: true,
    commit: "10a644e",
    nowMs: () => clock,
    expectedMigrations,
    ...overrides,
  });

  it("DB와 PayPal 토큰이 모두 되면 status ok다", async () => {
    expect(await checkHealth(deps())).toEqual({ status: "ok", database: "ok", paypal: "ok", webhook: "configured", commit: "10a644e" });
  });

  it("PayPal 토큰을 못 받으면 fail이고 결과에 오류 문구·키가 없다", async () => {
    const refused = paypal({ status: 401, body: invalidClient });

    const report = await checkHealth(deps({ paypal: refused.client }));

    expect(report).toEqual({ status: "fail", database: "ok", paypal: "fail", webhook: "configured", commit: "10a644e" });
    expect(JSON.stringify(report)).not.toMatch(/invalid_client|Client Authentication|stand-in|401/);
  });

  it("키가 없으면 paypal은 not_configured이고 status는 fail이다", async () => {
    expect(await checkHealth(deps({ paypal: null }))).toMatchObject({ status: "fail", database: "ok", paypal: "not_configured" });
  });

  it("웹훅 id가 없어도 status는 ok일 수 있고 webhook은 missing이다", async () => {
    expect(await checkHealth(deps({ webhookConfigured: false }))).toMatchObject({ status: "ok", webhook: "missing" });
  });

  it("60초 안에 다시 부르면 토큰 요청은 한 번이다", async () => {
    const failing = paypal({ status: 503, body: {} });
    const healthy = paypal();
    const d = deps({ paypal: failing.client });

    const first = await checkHealth(d);
    clock += 59_000;
    const second = await checkHealth(d);
    clock += 1_000;
    const third = await checkHealth(d);
    await checkHealth(deps({ paypal: healthy.client }));
    await checkHealth(deps({ paypal: healthy.client }));

    expect([first.paypal, second.paypal, third.paypal]).toEqual(["fail", "fail", "fail"]);
    expect(failing.to(TOKEN)).toHaveLength(2); // the first call, then once the 60 s passed
    expect(healthy.to(TOKEN)).toHaveLength(1);
  });

  it("적용된 마이그레이션이 저널보다 적으면 database는 fail이다", async () => {
    // drizzle's "id SERIAL" isn't a rowid alias in SQLite (it stays NULL), so the last row is found by rowid.
    await db.run(sql`DELETE FROM __drizzle_migrations WHERE rowid = (SELECT max(rowid) FROM __drizzle_migrations)`);

    expect(await checkHealth(deps())).toMatchObject({ status: "fail", database: "fail", paypal: "ok" });
  });

  it("DB에 닿지 못하거나 마이그레이션 전이면 database는 fail이다", async () => {
    const empty = createDb(":memory:");
    const closed = createDb(":memory:");
    await runMigrations(closed);
    closed.$client.close();

    expect([await checkDatabase(empty, expectedMigrations), await checkDatabase(closed, expectedMigrations)]).toEqual(["fail", "fail"]);
    expect(await checkDatabase(db, expectedMigrations)).toBe("ok");
  });

  it("커밋은 git 커밋 id일 때만 앞 7자로 보인다", () => {
    expect(shortCommit("10A644E5f3c2d1e0b9a8f7e6d5c4b3a2f1e0d9c8")).toBe("10a644e");
    expect([shortCommit(undefined), shortCommit(""), shortCommit("main"), shortCommit("10a644e; rm -rf /")]).toEqual([null, null, null, null]);
  });
});
