import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createDb, type Db } from "./client";

export async function runMigrations(db: Db, migrationsFolder = "drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}

// Applies the migrations with a client of its own and closes it: the server's startup code and its routes are
// bundled apart, so they don't share getDb(). Returns how many migrations the database has applied in all.
export async function migrateDatabase(url: string, migrationsFolder = "drizzle"): Promise<number> {
  const db = createDb(url);
  try {
    await runMigrations(db, migrationsFolder);
    return await appliedMigrationCount(db);
  } finally {
    db.$client.close();
  }
}

// How many migrations drizzle recorded in this database (0 before the first one).
export async function appliedMigrationCount(db: Db): Promise<number> {
  const [table] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`);
  if (!table?.n) return 0;
  const [row] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM __drizzle_migrations`);
  return Number(row?.n ?? 0);
}

// How many migrations this build ships (drizzle/meta/_journal.json).
export function expectedMigrationCount(migrationsFolder = "drizzle"): number {
  const journal: unknown = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const entries = typeof journal === "object" && journal !== null && "entries" in journal ? journal.entries : undefined;
  if (!Array.isArray(entries)) throw new Error("the migrations journal has no entries");
  return entries.length;
}
