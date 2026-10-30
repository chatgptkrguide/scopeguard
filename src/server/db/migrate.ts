import { migrate } from "drizzle-orm/libsql/migrator";
import type { Db } from "./client";

export async function runMigrations(db: Db, migrationsFolder = "drizzle"): Promise<void> {
  await migrate(db, { migrationsFolder });
}
