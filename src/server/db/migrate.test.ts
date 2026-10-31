import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";

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
