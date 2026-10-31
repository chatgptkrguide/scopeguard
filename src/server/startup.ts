import { join, posix } from "node:path";
import { ZodError } from "zod";
import { migrateDatabase } from "./db/migrate";
import { parseEnv } from "./env";

// What the server checks and does before it takes requests (src/instrumentation.ts). Not server-only: it runs at
// startup, outside React Server Components. Messages name variables, never their values.

export const RENDER_DISK_DATABASE_PREFIX = "file:/var/data/";

// A file path under the Render disk, written plainly (no "..", no doubled slashes) so it can't point elsewhere.
function onRenderDisk(url: string | undefined): boolean {
  if (!url?.startsWith(RENDER_DISK_DATABASE_PREFIX)) return false;
  const path = url.slice("file:".length);
  return path.length > "/var/data/".length && posix.normalize(path) === path;
}

// What is wrong with this environment for a deployed server, as messages that name variables but never their values.
// On Render (RENDER === "true"): PAYPAL_ENV must be exactly "sandbox" (P2-S4; the hackathon is sandbox only and live
// payer links aren't supported), and DATABASE_URL must point under the disk, or the SQLite file would vanish on the
// next deploy. Elsewhere (local, tests): no extra rules.
export function startupProblems(source: Readonly<Record<string, string | undefined>>): string[] {
  if (source.RENDER !== "true") return [];
  const problems: string[] = [];
  if (source.PAYPAL_ENV !== "sandbox") problems.push("PAYPAL_ENV must be sandbox on Render");
  if (!onRenderDisk(source.DATABASE_URL)) problems.push("DATABASE_URL must be under /var/data on Render");
  return problems;
}

// zod issues reduced to the variable and the kind of problem. Custom issues are the env schema's own sentences,
// which name variables only.
function envProblems(error: ZodError): string[] {
  return error.issues.map((issue) => (issue.code === "custom" ? issue.message : `${issue.path.join(".") || "environment"} is invalid (${issue.code})`));
}

// Checks the environment (env schema + startupProblems), then applies migrations with its own client and closes it.
// Throws an Error whose message lists problems by variable name only.
export async function prepareServer(
  source: Readonly<Record<string, string | undefined>> = process.env,
  migrationsFolder: string = join(process.cwd(), "drizzle"),
): Promise<{ migrations: number }> {
  const problems: string[] = [];
  let databaseUrl: string | null = null;
  try {
    databaseUrl = parseEnv({ ...source }).DATABASE_URL;
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    problems.push(...envProblems(error));
  }
  problems.push(...startupProblems(source));
  if (problems.length > 0 || databaseUrl === null) throw new Error(problems.join("; "));
  return { migrations: await migrateDatabase(databaseUrl, migrationsFolder) };
}

// What register() runs: the checks and migrations, or the process exits with code 1, so a misconfigured deploy fails
// instead of serving errors (Next only logs a throw from register and keeps the process alive).
export async function startServer(source: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  try {
    const { migrations } = await prepareServer(source);
    console.log(`Tollgate: database ready (${migrations} migrations applied)`);
  } catch (error) {
    console.error(`Tollgate refused to start: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exit(1);
  }
}
