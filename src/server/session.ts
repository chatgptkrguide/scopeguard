import "server-only";
import { cookies } from "next/headers";
import { projectIdForVisitor } from "./db/demo";
import { isVisitorId, VISITOR_COOKIE } from "./visitor";

// The visitor id from the demo cookie, or null if it's missing or malformed.
export async function readVisitorId(): Promise<string | null> {
  const value = (await cookies()).get(VISITOR_COOKIE)?.value;
  return isVisitorId(value) ? value : null;
}

// The only project this request may read or change. Ownership comes from the cookie, never from the form.
export async function currentProjectId(): Promise<string | null> {
  const visitorId = await readVisitorId();
  return visitorId ? projectIdForVisitor(visitorId) : null;
}
