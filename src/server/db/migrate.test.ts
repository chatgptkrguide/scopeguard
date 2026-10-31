import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lt, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";
import { projects } from "./schema";

const MIGRATIONS = "drizzle";

interface Journal {
  entries: { tag: string }[];
}

// A migrations folder with only the first `count` migrations, as a database migrated by an earlier build saw it.
function firstMigrations(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tollgate-migrations-"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as Journal;
  const entries = journal.entries.slice(0, count);
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) cpSync(join(MIGRATIONS, `${tag}.sql`), join(dir, `${tag}.sql`));
  return dir;
}

// Raw SQL, because schema.ts already describes columns the older database doesn't have.
async function insertOldProject(db: Db, id: string, createdAt: string): Promise<void> {
  await db.run(sql`
    INSERT INTO projects (id, client_name, client_email, title, hourly_rate_cents, hours_per_day, agreed_on, due_on, created_at)
    VALUES (${id}, 'Harbor & Pine Coffee', 'maya@harborandpine.example', 'Online ordering site', 5000, 6, '2026-10-21', '2026-11-15', ${createdAt})
  `);
}

async function lastSeen(db: Db): Promise<{ id: string; created_at: string; last_seen_at: string }[]> {
  return db.all(sql`SELECT id, created_at, last_seen_at FROM projects ORDER BY id`);
}

describe("마이그레이션", () => {
  let db: Db;
  let oldFolder: string;

  beforeEach(() => {
    db = createDb(":memory:");
    oldFolder = firstMigrations(1);
  });

  afterEach(() => {
    rmSync(oldFolder, { recursive: true, force: true });
  });

  it("0000만 적용된 DB에 프로젝트 행이 있어도 0001이 성공하고 last_seen_at을 그 행의 created_at으로 채운다", async () => {
    await runMigrations(db, oldFolder);
    await insertOldProject(db, "demo", "2026-10-30T08:00:00.000Z");
    await insertOldProject(db, "v_old", "2026-10-31T12:30:00.000Z");

    await runMigrations(db, MIGRATIONS);

    expect(await lastSeen(db)).toEqual([
      { id: "demo", created_at: "2026-10-30T08:00:00.000Z", last_seen_at: "2026-10-30T08:00:00.000Z" },
      { id: "v_old", created_at: "2026-10-31T12:30:00.000Z", last_seen_at: "2026-10-31T12:30:00.000Z" },
    ]);
  });

  it("0000만 적용된 DB에 행이 있어도 last_seen_at 인덱스까지 만들어지고 정리 조회가 그 인덱스를 쓴다", async () => {
    await runMigrations(db, oldFolder);
    await insertOldProject(db, "demo", "2026-10-30T08:00:00.000Z");

    await runMigrations(db, MIGRATIONS);

    const indexes = await db.all<{ name: string }>(sql`PRAGMA index_list(projects)`);
    expect(indexes.map((i) => i.name)).toContain("projects_last_seen_idx");
    // The same lookup deleteExpiredCopies makes.
    const lookup = db.select({ id: projects.id }).from(projects).where(lt(projects.lastSeenAt, "2026-10-31T00:00:00.000Z")).toSQL();
    const plan = await db.$client.execute({ sql: `EXPLAIN QUERY PLAN ${lookup.sql}`, args: lookup.params.map(String) });
    expect(plan.rows.map((r) => String(r.detail)).join("\n")).toContain("projects_last_seen_idx");
  });

  it("이미 끝까지 적용된 DB에 다시 돌리면 아무것도 바꾸지 않는다(채우기가 다시 돌지 않는다)", async () => {
    await runMigrations(db, MIGRATIONS);
    await db.run(sql`
      INSERT INTO projects (id, client_name, client_email, title, hourly_rate_cents, hours_per_day, agreed_on, due_on, created_at, last_seen_at)
      VALUES ('v_new', 'Harbor & Pine Coffee', 'maya@harborandpine.example', 'Online ordering site', 5000, 6, '2026-10-21', '2026-11-15',
        '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z')
    `);

    await runMigrations(db, MIGRATIONS);

    expect(await lastSeen(db)).toEqual([
      { id: "v_new", created_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-31T00:00:00.000Z" },
    ]);
  });

  it("last_seen_at에 NULL은 넣을 수 없다", async () => {
    await runMigrations(db, MIGRATIONS);

    await expect(
      db.run(sql`
        INSERT INTO projects (id, client_name, client_email, title, hourly_rate_cents, hours_per_day, agreed_on, due_on, created_at, last_seen_at)
        VALUES ('v_null', 'c', 'c@example.com', 't', 5000, 6, '2026-10-21', '2026-11-15', '2026-10-01T00:00:00.000Z', NULL)
      `),
    ).rejects.toThrow();
  });
});

// Migration 0003 adds the activity table and the send claim column. A deployed database already has copies
// in it, so it has to apply on top of real rows without rebuilding or dropping a table.
describe("마이그레이션 0003(활동 기록·발송 표시)", () => {
  let db: Db;
  let before0003: string;

  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as Journal;
  const tag0003 = journal.entries[3]?.tag ?? "";

  beforeEach(() => {
    db = createDb(":memory:");
    before0003 = firstMigrations(3);
  });

  afterEach(() => {
    rmSync(before0003, { recursive: true, force: true });
  });

  // Raw SQL with the columns that existed after 0002: one copy with a paid order and a draft.
  async function insertCopyBefore0003(): Promise<void> {
    const at = "2026-10-31T12:00:00.000Z";
    await db.run(sql`
      INSERT INTO projects (id, client_name, client_email, title, hourly_rate_cents, hours_per_day, agreed_on, due_on, created_at, last_seen_at)
      VALUES ('v_kept', 'Harbor & Pine Coffee', 'maya@harborandpine.example', 'Online ordering site', 5000, 6, '2026-10-21', '2026-11-15', ${at}, ${at})
    `);
    await db.run(sql`INSERT INTO scope_items (id, project_id, title, amount_cents, position) VALUES ('s1', 'v_kept', 'Landing page', 90000, 1)`);
    await db.run(sql`INSERT INTO messages (id, project_id, from_party, author, sent_at, body) VALUES ('m1', 'v_kept', 'client', 'Maya', ${at}, 'Could you add gift cards and a loyalty page?')`);
    await db.run(sql`
      INSERT INTO findings (id, message_id, quote, quote_start, quote_end, title, estimated_hours, reason)
      VALUES ('f1', 'm1', 'gift cards', 14, 24, 'Gift card page', 5, 'r'), ('f2', 'm1', 'a loyalty page', 29, 43, 'Loyalty page', 13, 'r')
    `);
    await db.run(sql`
      INSERT INTO change_orders (id, project_id, finding_id, title, hours, amount_cents, extra_days, status, paypal_invoice_id, payer_view_url, sent_at, paid_at)
      VALUES ('c1', 'v_kept', 'f1', 'Gift card page', 5, 25000, 1, 'paid', 'INV2-AAAA-BBBB-CCCC-DDDD', NULL, '2026-10-24T16:00:00Z', '2026-10-26T10:00:00Z'),
             ('c2', 'v_kept', 'f2', 'Loyalty page', 13, 65000, 3, 'draft', NULL, NULL, NULL, NULL)
    `);
  }

  const TABLES = ["projects", "scope_items", "messages", "findings", "change_orders"] as const;
  async function snapshot(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const rows = await db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table} ORDER BY id`));
      out[table] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "send_claimed_at")));
    }
    return out;
  }

  it("0003 SQL에는 표 재구성(__new_)이나 DROP이 없고 열 추가 한 줄만 change_orders를 건드린다", () => {
    const migration = readFileSync(join(MIGRATIONS, `${tag0003}.sql`), "utf8");

    expect(tag0003).toMatch(/^0003_/);
    expect(migration).not.toMatch(/__new_|DROP|RENAME|PRAGMA/i);
    expect(migration.match(/change_orders/g)?.length).toBe(2); // the ALTER and the activity foreign key
    expect(migration).toContain("ALTER TABLE `change_orders` ADD `send_claimed_at` text;");
  });

  it("0003 뒤 change_orders에 send_claimed_at 열이 있고 기존 행의 값은 NULL이다", async () => {
    await runMigrations(db, before0003);
    await insertCopyBefore0003();

    await runMigrations(db, MIGRATIONS);

    const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(change_orders)`);
    expect(columns.map((c) => c.name)).toContain("send_claimed_at");
    expect(await db.all(sql`SELECT id, send_claimed_at FROM change_orders ORDER BY id`)).toEqual([
      { id: "c1", send_claimed_at: null },
      { id: "c2", send_claimed_at: null },
    ]);
  });

  it("0003은 행이 있는 DB에 적용해도 기존 견적·사본을 지우지 않는다", async () => {
    await runMigrations(db, before0003);
    await insertCopyBefore0003();
    const kept = await snapshot();

    await runMigrations(db, MIGRATIONS);

    expect(await snapshot()).toEqual(kept);
    expect(kept.change_orders).toHaveLength(2);
    // The new table works against the old rows, and nothing points nowhere.
    await db.run(sql`
      INSERT INTO activity_events (project_id, change_order_id, kind, actor, summary, detail, at)
      VALUES ('v_kept', 'c2', 'invoice_created', 'paypal', 'Created PayPal invoice', '{"reused":false}', '2026-11-01T09:00:00.000Z')
    `);
    expect(await db.all(sql`SELECT project_id, change_order_id, kind FROM activity_events`)).toEqual([
      { project_id: "v_kept", change_order_id: "c2", kind: "invoice_created" },
    ]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
