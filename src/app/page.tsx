import { connection } from "next/server";
import { Suspense, type ReactElement } from "react";
import { Workspace } from "@/components/Workspace";
import { WorkspaceSkeleton } from "@/components/WorkspaceSkeleton";
import { getDb } from "@/server/db/client";
import { ensureDemoCopy } from "@/server/db/demo";
import { getWorkspace } from "@/server/db/queries";
import { readVisitorId } from "@/server/session";

// Sending stays off until the PayPal invoice flow lands (P2).
const SEND_BLOCKED_REASON = "PayPal invoicing isn't connected yet, so nothing is sent.";

export default function Home() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <VisitorWorkspace />
    </Suspense>
  );
}

// Reads the visitor cookie, creates the visitor's own copy on the first visit, then renders it from the database.
async function VisitorWorkspace(): Promise<ReactElement> {
  const visitorId = await readVisitorId();
  if (!visitorId) return <MissingVisitorNotice />;
  // Cookies alone still allow a prerender (Partial Prefetching builds a per-session shell with them).
  // Everything below needs a real request: the clock, random ids, and the copy's database writes.
  await connection();

  const db = getDb();
  const { projectId } = await ensureDemoCopy(db, visitorId, new Date());
  const data = await getWorkspace(db, projectId);
  if (!data) throw new Error("demo copy missing after ensure");
  return <Workspace data={data} sendBlockedReason={SEND_BLOCKED_REASON} />;
}

// Only when the request skipped proxy.ts, so it has no visitor cookie yet.
function MissingVisitorNotice() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
      <p className="font-serif text-[22px]">Reload the page to start your demo.</p>
    </main>
  );
}
