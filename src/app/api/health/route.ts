import { connection } from "next/server";
import { checkHealth, liveHealthDeps } from "@/server/health";

// The deep check (database and a PayPal token), for the daily check and phase 3 acceptance (b). 200 when both work,
// else 503. The body is the HealthReport only.
export async function GET(): Promise<Response> {
  await connection(); // never at build time: the build has no database (Render's disk exists only at runtime)
  const headers = { "Cache-Control": "no-store" };
  try {
    const report = await checkHealth(liveHealthDeps());
    return Response.json(report, { status: report.status === "ok" ? 200 : 503, headers });
  } catch (error) {
    console.error("health check failed", error);
    return Response.json({ status: "fail" }, { status: 503, headers });
  }
}
