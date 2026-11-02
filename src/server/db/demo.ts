import { createHash } from "node:crypto";
import { and, count, eq, gt, inArray, lt, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { locateFindings } from "../../domain/finding";
import { extraDaysForHours, priceForHours } from "../../domain/money";
import type { Db } from "./client";
import { isUniqueViolation } from "./errors";
import { activityEvents, changeOrders, findings, messages, projects, scopeItems } from "./schema";

// Every visitor gets their own copy of this demo project. Harbor & Pine Coffee and Maya Lindqvist are fictional.

export const LOCAL_DEMO_PROJECT_ID = "demo"; // `pnpm db:seed` only; the screen never reads this id
export const DEMO_COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Opening a copy moves its last-seen time at most once an hour, so a page view rarely writes.
export const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;

const RATE_CENTS = 5000; // $50 an hour
const HOURS_PER_DAY = 6;

const demoProject = {
  clientName: "Harbor & Pine Coffee",
  clientEmail: "maya@harborandpine.example",
  title: "Online ordering site",
  hourlyRateCents: RATE_CENTS,
  hoursPerDay: HOURS_PER_DAY,
  agreedOn: "2026-10-21",
  dueOn: "2026-11-15",
};

const demoScope = [
  { title: "Landing page", amountCents: 90000 },
  { title: "Menu with online ordering", amountCents: 120000 },
  { title: "Contact form", amountCents: 30000 },
];

// The story's own dates stay fixed; only the copy's bookkeeping times use "now".
const demoMessages = [
  {
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-21T08:12:00Z",
    body: "Hi! Excited to get started. As we discussed: a landing page, our menu with online ordering, and a contact form. We'd love to launch by November 15.",
  },
  {
    from: "me",
    author: "You",
    sentAt: "2026-10-21T09:30:00Z",
    body: "Thanks Maya. Sending the quote for those three pages now, with launch on November 15.",
  },
  {
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-24T15:05:00Z",
    body: "Quick one: could we sell gift cards on the site too? Holiday season is coming.",
  },
  {
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-28T11:40:00Z",
    body: "The menu looks great so far! Could you also add a loyalty page where customers log in to see their stamps? Our investors want it at launch.",
  },
] as const;

// `message` is an index into demoMessages; `order` is the change order the finding already has.
const demoFindingDrafts = [
  {
    message: 2,
    quote: "sell gift cards on the site",
    title: "Gift card page",
    estimatedHours: 5,
    reason: "Gift card sales need their own page and checkout flow.",
    // Sample history: paid before this demo started, so it has no PayPal invoice of its own.
    order: { status: "paid", sentAt: "2026-10-24T16:00:00Z", paidAt: "2026-10-26T10:00:00Z" },
  },
  {
    message: 3,
    quote: "add a loyalty page where customers log in to see their stamps",
    title: "Loyalty page with customer login",
    estimatedHours: 13,
    reason:
      "Version 1 covers a landing page, the menu with ordering, and a contact form. Customer accounts aren't part of it.",
    order: { status: "draft" },
  },
] as const;

export interface DemoRows {
  // last_seen_at has a database default only for migration 0001; a copy always sets it.
  project: typeof projects.$inferInsert & { lastSeenAt: string };
  scopeItems: (typeof scopeItems.$inferInsert)[];
  messages: (typeof messages.$inferInsert)[];
  findings: (typeof findings.$inferInsert)[];
  changeOrders: (typeof changeOrders.$inferInsert)[];
}

// The rows of one copy. Child ids are new on every call, so a reset never brings back an old
// change order id (it becomes the PayPal request id, which would return the old invoice).
export function demoRows(projectId: string, now: Date, newId: () => string = () => crypto.randomUUID()): DemoRows {
  const at = now.toISOString();
  const messageRows = demoMessages.map((m) => ({ id: newId(), projectId, ...m }));

  const findingRows = demoFindingDrafts.map(({ message, quote, title, estimatedHours, reason }) => {
    const draft = { quote, title, estimatedHours, reason };
    const { id: messageId, body } = messageRows[message];
    // Offsets come from the same check the app runs on model output, so a typo in the demo text fails loudly.
    const [located] = locateFindings(body, [draft]);
    if (!located) throw new Error(`demo finding "${draft.title}" does not quote message ${message}`);
    return { id: newId(), messageId, ...draft, quoteStart: located.start, quoteEnd: located.end };
  });

  const orderRows = demoFindingDrafts.map(({ order, estimatedHours, title }, i) => ({
    id: newId(),
    projectId,
    findingId: findingRows[i].id,
    title,
    hours: estimatedHours,
    amountCents: priceForHours(estimatedHours, RATE_CENTS),
    extraDays: extraDaysForHours(estimatedHours, HOURS_PER_DAY),
    ...order,
  }));

  return {
    project: { id: projectId, ...demoProject, createdAt: at, lastSeenAt: at },
    scopeItems: demoScope.map((s, i) => ({ id: newId(), projectId, ...s, position: i + 1 })),
    messages: messageRows,
    findings: findingRows,
    changeOrders: orderRows,
  };
}

// The visitor's copy id. A one-way hash, so the database never holds the cookie value.
export function projectIdForVisitor(visitorId: string): string {
  return `v_${createHash("sha256").update(`tollgate-demo-v1:${visitorId}`).digest("base64url").slice(0, 22)}`;
}

function insertStatements(db: Db, rows: DemoRows) {
  return [
    db.insert(projects).values(rows.project),
    db.insert(scopeItems).values(rows.scopeItems),
    db.insert(messages).values(rows.messages),
    db.insert(findings).values(rows.findings),
    db.insert(changeOrders).values(rows.changeOrders),
  ] as const;
}

// Deletes children explicitly, so removing a copy never depends on the connection's foreign_keys setting.
// A new table that hangs off a project needs its own line here.
function deleteProjectStatements(db: Db, inProjects: (projectIdColumn: SQLiteColumn) => SQL) {
  const projectMessageIds = db.select({ id: messages.id }).from(messages).where(inProjects(messages.projectId));
  return [
    db.delete(activityEvents).where(inProjects(activityEvents.projectId)),
    db.delete(changeOrders).where(inProjects(changeOrders.projectId)),
    db.delete(findings).where(inArray(findings.messageId, projectMessageIds)),
    db.delete(messages).where(inProjects(messages.projectId)),
    db.delete(scopeItems).where(inProjects(scopeItems.projectId)),
    db.delete(projects).where(inProjects(projects.id)),
  ] as const;
}

export interface EnsureResult {
  projectId: string;
  created: boolean;
  // No copy exists and mayCreate said no, so nothing was written. projectId is the id the copy would get.
  refused: boolean;
}

// Asked only when the visitor has no copy yet, right before one would be written (see demo-limit.ts).
export type MayCreateCopy = (db: Db, now: Date) => Promise<boolean>;

const alwaysCreate: MayCreateCopy = async () => true;

// Returns the visitor's copy, creating it on first use if mayCreate allows. Two requests racing for the same
// visitor end with one copy: the project id is the primary key, and the losing batch rolls back whole.
export async function ensureDemoCopy(
  db: Db,
  visitorId: string,
  now: Date,
  mayCreate: MayCreateCopy = alwaysCreate,
): Promise<EnsureResult> {
  const projectId = projectIdForVisitor(visitorId);
  const [existing] = await db
    .select({ lastSeenAt: projects.lastSeenAt })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (existing) {
    const staleBefore = new Date(now.getTime() - LAST_SEEN_REFRESH_MS).toISOString();
    if (existing.lastSeenAt < staleBefore) {
      await db
        .update(projects)
        .set({ lastSeenAt: now.toISOString() })
        .where(and(eq(projects.id, projectId), lt(projects.lastSeenAt, staleBefore)));
    }
    return { projectId, created: false, refused: false };
  }

  if (!(await mayCreate(db, now))) return { projectId, created: false, refused: true };

  try {
    await db.batch(insertStatements(db, demoRows(projectId, now)));
  } catch (error) {
    if (isUniqueViolation(error)) return { projectId, created: false, refused: false };
    throw error;
  }

  // Cleanup rides along with new copies, so there is no scheduler. A failure must not cost the visitor their page.
  try {
    await deleteExpiredCopies(db, now);
  } catch (error) {
    console.error("deleting expired demo copies failed", error);
  }
  return { projectId, created: true, refused: false };
}

// How many copies were created (or reset, which writes a new created_at) after `since`. One row per copy,
// so resetting the same copy again never counts twice.
export async function countCopiesCreatedSince(db: Db, since: Date): Promise<number> {
  const [{ copies }] = await db
    .select({ copies: count() })
    .from(projects)
    .where(gt(projects.createdAt, since.toISOString()));
  return copies;
}

// Puts the copy back to the seed in one batch: same project id, fresh child ids, created and last seen now.
export async function resetDemoCopy(db: Db, projectId: string, now: Date): Promise<void> {
  await db.batch([
    ...deleteProjectStatements(db, (column) => eq(column, projectId)),
    ...insertStatements(db, demoRows(projectId, now)),
  ]);
}

// Deletes copies nobody has opened for longer than maxAgeMs, with all their rows. Returns how many.
export async function deleteExpiredCopies(db: Db, now: Date, maxAgeMs: number = DEMO_COPY_MAX_AGE_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  // A subquery, not a list read beforehand: a copy opened between the read and the delete must survive.
  const expired = db.select({ id: projects.id }).from(projects).where(lt(projects.lastSeenAt, cutoff));
  const [[{ copies }]] = await db.batch([
    db.select({ copies: count() }).from(projects).where(lt(projects.lastSeenAt, cutoff)),
    ...deleteProjectStatements(db, (column) => inArray(column, expired)),
  ]);
  return copies;
}
