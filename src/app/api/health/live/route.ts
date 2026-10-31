import { connection } from "next/server";
import { checkLiveDatabase } from "@/server/health";

// What Render polls every few seconds (healthCheckPath): the database only, never PayPal, so a PayPal outage can't
// make Render restart the app.
export async function GET(): Promise<Response> {
  await connection(); // never at build time
  const database = await checkLiveDatabase();
  return Response.json({ database }, { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
