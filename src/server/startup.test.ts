import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "./db/client";
import { prepareServer, startServer, startupProblems } from "./startup";

const journalEntries = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: unknown[] }).entries.length;
const ON_RENDER = { RENDER: "true", PAYPAL_ENV: "sandbox", DATABASE_URL: "file:/var/data/tollgate.db" };

describe("서버 시작 검사와 마이그레이션", () => {
  let dir: string;
  let url: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tollgate-startup-"));
    url = `file:${join(dir, "fresh", "tollgate.db")}`; // the folder doesn't exist yet, like an empty disk
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function tablesAndRows(): Promise<{ tables: string[]; migrations: unknown[] }> {
    const db = createDb(url);
    try {
      const tables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
      const migrations = await db.all(sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY rowid`);
      return { tables: tables.map((t) => t.name), migrations };
    } finally {
      db.$client.close();
    }
  }

  it("빈 폴더의 DATABASE_URL로 prepareServer를 부르면 마이그레이션이 끝나 모든 표가 있고 적용 수가 저널 수와 같다", async () => {
    const result = await prepareServer({ DATABASE_URL: url }, "drizzle");

    const { tables, migrations } = await tablesAndRows();
    expect(result).toEqual({ migrations: journalEntries });
    expect(migrations).toHaveLength(journalEntries);
    expect(tables).toEqual(["__drizzle_migrations", "activity_events", "change_orders", "findings", "messages", "paypal_sends", "projects", "scope_items", "webhook_events"]);
  });

  it("이미 마이그레이션된 DB로 다시 부르면 아무것도 바뀌지 않는다", async () => {
    await prepareServer({ DATABASE_URL: url }, "drizzle");
    const db = createDb(url);
    await db.run(sql`INSERT INTO paypal_sends (change_order_id, at) VALUES ('kept', '2026-11-01T09:00:00.000Z')`);
    db.$client.close();
    const before = await tablesAndRows();

    const again = await prepareServer({ DATABASE_URL: url }, "drizzle");

    expect(again).toEqual({ migrations: journalEntries });
    expect(await tablesAndRows()).toEqual(before);
    const check = createDb(url);
    expect(await check.all(sql`SELECT change_order_id FROM paypal_sends`)).toEqual([{ change_order_id: "kept" }]);
    check.$client.close();
  });

  it("RENDER가 true이고 PAYPAL_ENV가 sandbox가 아니면 시작을 거부한다 (P2-S4)", async () => {
    const live = { ...ON_RENDER, PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "WH1" };

    expect(startupProblems(live)).toEqual(["PAYPAL_ENV must be sandbox on Render"]);
    expect(startupProblems({ ...ON_RENDER, PAYPAL_ENV: "Sandbox" })).toEqual(["PAYPAL_ENV must be sandbox on Render"]);
    await expect(prepareServer(live, "drizzle")).rejects.toThrow("PAYPAL_ENV must be sandbox on Render");
  });

  it("RENDER가 true이고 PAYPAL_ENV가 비어 있어도 시작을 거부한다(기본값에 기대지 않음)", async () => {
    expect(startupProblems({ ...ON_RENDER, PAYPAL_ENV: "" })).toEqual(["PAYPAL_ENV must be sandbox on Render"]);
    expect(startupProblems({ RENDER: "true", DATABASE_URL: ON_RENDER.DATABASE_URL })).toEqual(["PAYPAL_ENV must be sandbox on Render"]);
    await expect(prepareServer({ ...ON_RENDER, PAYPAL_ENV: undefined }, "drizzle")).rejects.toThrow("PAYPAL_ENV must be sandbox on Render");
  });

  it("RENDER가 true이고 DATABASE_URL이 /var/data 아래가 아니면 시작을 거부한다", () => {
    const outside = ["", "file:data/tollgate.db", "file:/var/data", "file:/var/data/", "file:/var/data/../tmp/tollgate.db", "file:/var/data//tollgate.db", "file:/var/database.db", "libsql://example.turso.io"];

    for (const DATABASE_URL of outside) expect(startupProblems({ ...ON_RENDER, DATABASE_URL }), DATABASE_URL).toEqual(["DATABASE_URL must be under /var/data on Render"]);
    expect(startupProblems({ RENDER: "true", PAYPAL_ENV: "sandbox" })).toEqual(["DATABASE_URL must be under /var/data on Render"]);
    expect(startupProblems(ON_RENDER)).toEqual([]);
    expect(startupProblems({ ...ON_RENDER, DATABASE_URL: "file:/var/data/sub/tollgate.db" })).toEqual([]);
  });

  it("RENDER가 없으면(로컬) 위 두 규칙을 적용하지 않는다", async () => {
    expect(startupProblems({ PAYPAL_ENV: "live", DATABASE_URL: "file:data/tollgate.db" })).toEqual([]);
    expect(startupProblems({ RENDER: "false", PAYPAL_ENV: "" })).toEqual([]);
    await expect(prepareServer({ DATABASE_URL: url }, "drizzle")).resolves.toEqual({ migrations: journalEntries });
  });

  it("시작 거부 메시지에 환경변수 값이 들어가지 않는다", async () => {
    const values = {
      RENDER: "true",
      PAYPAL_ENV: "production-SECRETVALUE1",
      DATABASE_URL: "file:/tmp/SECRETVALUE2.db",
      PAYPAL_WEBHOOK_ID: "SECRET_VALUE_3",
      PAYPAL_CLIENT_SECRET: "SECRETVALUE4",
    };

    const error = await prepareServer(values, "drizzle").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("PAYPAL_ENV");
    expect(message).toContain("PAYPAL_WEBHOOK_ID");
    expect(message).toContain("DATABASE_URL must be under /var/data on Render");
    expect(message).not.toMatch(/SECRET|production|\/tmp/);
  });

  it("PAYPAL_WEBHOOK_ID에 영문·숫자 말고 다른 글자가 있으면 env 검사가 거부한다", async () => {
    await expect(prepareServer({ DATABASE_URL: url, PAYPAL_WEBHOOK_ID: "WEBHOOK_ID" }, "drizzle")).rejects.toThrow(/^PAYPAL_WEBHOOK_ID is invalid/);
    expect(await prepareServer({ DATABASE_URL: url, PAYPAL_WEBHOOK_ID: "8PT597110X687430LKGECATA" }, "drizzle")).toEqual({ migrations: journalEntries });
  });

  it("live인데 키가 빠지면 변수 이름만 담은 문장으로 거부한다", async () => {
    await expect(prepareServer({ DATABASE_URL: url, PAYPAL_ENV: "live" }, "drizzle")).rejects.toThrow("PAYPAL_ENV=live needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID");
  });

  it("시작 검사가 실패하면 이유를 남기고 process.exit(1)로 시작을 거부한다", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await startServer({ ...ON_RENDER, PAYPAL_ENV: "" });

    expect(logged).toHaveBeenCalledWith("Tollgate refused to start: PAYPAL_ENV must be sandbox on Render");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("검사와 마이그레이션이 끝나면 적용 수를 남기고 종료하지 않는다", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    await startServer({ DATABASE_URL: url });

    expect(logged).toHaveBeenCalledWith(`Tollgate: database ready (${journalEntries} migrations applied)`);
    expect(exit).not.toHaveBeenCalled();
  });
});
