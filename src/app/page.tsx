import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense, type ReactElement } from "react";
import { Workspace } from "@/components/Workspace";
import { WorkspaceSkeleton } from "@/components/WorkspaceSkeleton";
import { getDb } from "@/server/db/client";
import { openVisitorWorkspace } from "@/server/db/queries";
import { paypalConfig } from "@/server/paypal/token";
import { clientAddress, demoCopyGate } from "@/server/demo-limit";
import { readVisitorId } from "@/server/session";

// Without sandbox keys (a judge running it locally, the phase 1 browser tests) sending stays off and says why.
const SEND_BLOCKED_REASON = "PayPal sandbox keys aren't set on this server, so nothing can be sent.";
// When a new copy is refused (demo-limit.ts) the visitor sees the demo read-only; nothing of theirs is saved.
const PREVIEW_REASON = "Too many new demos were started recently, so this one is view-only and nothing is saved. Try again later.";

export default function Home() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <VisitorWorkspace />
    </Suspense>
  );
}

// Reads the visitor cookie, creates the visitor's own copy on the first visit, then renders it from the database.
// Past the limits on new copies it renders the seed from memory instead.
async function VisitorWorkspace(): Promise<ReactElement> {
  const visitorId = await readVisitorId();
  if (!visitorId) return <MissingVisitorNotice />;
  // Cookies alone still allow a prerender (Partial Prefetching builds a per-session shell with them).
  // Everything below needs a real request: the clock, random ids, and the copy's database writes.
  await connection();

  const mayCreate = demoCopyGate(clientAddress(await headers()));
  const { data, preview } = await openVisitorWorkspace(getDb(), visitorId, new Date(), { mayCreate });
  const sendBlockedReason = preview ? PREVIEW_REASON : paypalConfig() ? null : SEND_BLOCKED_REASON;
  return <Workspace data={data} sendBlockedReason={sendBlockedReason} />;
}

// Only when the request skipped proxy.ts, so it has no visitor cookie yet.
function MissingVisitorNotice() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-8">
      <p className="font-serif text-[22px]">Reload the page to start your demo.</p>
    </main>
  );
}
