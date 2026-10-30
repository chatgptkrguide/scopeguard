// pnpm db:migrate  applies migrations to DATABASE_URL (default file:data/scopeguard.db)
// pnpm db:seed     also (re)creates the demo project
import { createDb } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { DEMO_PROJECT_ID, seedDemo } from "../src/server/db/seed";

const db = createDb();
await runMigrations(db);
console.log("migrations applied");

if (process.argv.includes("--seed")) {
  await seedDemo(db);
  console.log(`demo project "${DEMO_PROJECT_ID}" seeded`);
}
