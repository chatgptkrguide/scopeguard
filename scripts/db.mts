// pnpm db:migrate  applies migrations to DATABASE_URL (default file:data/tollgate.db)
// pnpm db:seed     also (re)creates a local demo copy, for looking at the data outside the app
import { createDb } from "../src/server/db/client";
import { LOCAL_DEMO_PROJECT_ID, resetDemoCopy } from "../src/server/db/demo";
import { runMigrations } from "../src/server/db/migrate";

const db = createDb();
await runMigrations(db);
console.log("migrations applied");

if (process.argv.includes("--seed")) {
  await resetDemoCopy(db, LOCAL_DEMO_PROJECT_ID, new Date());
  console.log(`demo project "${LOCAL_DEMO_PROJECT_ID}" seeded`);
}
