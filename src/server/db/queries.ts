import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { displayedOrder, projectTotals, type WorkspaceData } from "@/domain/workspace";
import type { ChangeOrder, Finding, Message, Project, ScopeItem } from "@/domain/types";
import type { Db } from "./client";
import { demoRows, ensureDemoCopy, type MayCreateCopy } from "./demo";
import { changeOrders, findings, messages, projects, scopeItems } from "./schema";

// Columns are listed by hand, so bookkeeping columns (created_at, last_seen_at) never reach the screen.
const projectColumns = {
  id: projects.id,
  clientName: projects.clientName,
  clientEmail: projects.clientEmail,
  title: projects.title,
  hourlyRateCents: projects.hourlyRateCents,
  hoursPerDay: projects.hoursPerDay,
  agreedOn: projects.agreedOn,
  dueOn: projects.dueOn,
};

const findingColumns = {
  id: findings.id,
  messageId: findings.messageId,
  quote: findings.quote,
  quoteStart: findings.quoteStart,
  quoteEnd: findings.quoteEnd,
  title: findings.title,
  estimatedHours: findings.estimatedHours,
  reason: findings.reason,
};

const changeOrderColumns = {
  id: changeOrders.id,
  projectId: changeOrders.projectId,
  findingId: changeOrders.findingId,
  title: changeOrders.title,
  hours: changeOrders.hours,
  amountCents: changeOrders.amountCents,
  extraDays: changeOrders.extraDays,
  status: changeOrders.status,
  paypalInvoiceId: changeOrders.paypalInvoiceId,
  payerViewUrl: changeOrders.payerViewUrl,
  sentAt: changeOrders.sentAt,
  paidAt: changeOrders.paidAt,
};

// Change orders of one finding keep the order they were created in (SQLite's rowid grows with each insert), so a
// finding quoted again lists its cancelled orders oldest first instead of by their random UUIDs. rowid isn't
// declared in the schema, so it is named through the table here.
const changeOrderCreationOrder = sql`${changeOrders}.rowid`;

// Everything the workspace screen needs for one project, or null if the project doesn't exist.
// Every query filters by the project id, and the five run in one batch, so they read the same moment.
export async function getWorkspace(db: Db, projectId: string): Promise<WorkspaceData | null> {
  const [projectRows, scopeRows, messageRows, findingRows, orderRows] = await db.batch([
    db.select(projectColumns).from(projects).where(eq(projects.id, projectId)),
    db.select().from(scopeItems).where(eq(scopeItems.projectId, projectId)).orderBy(asc(scopeItems.position)),
    db.select().from(messages).where(eq(messages.projectId, projectId)).orderBy(asc(messages.sentAt), asc(messages.id)),
    db
      .select(findingColumns)
      .from(findings)
      .innerJoin(messages, eq(findings.messageId, messages.id))
      .where(eq(messages.projectId, projectId))
      .orderBy(asc(findings.quoteStart)),
    db
      .select(changeOrderColumns)
      .from(changeOrders)
      .innerJoin(findings, eq(changeOrders.findingId, findings.id))
      .innerJoin(messages, eq(findings.messageId, messages.id))
      .where(eq(changeOrders.projectId, projectId))
      .orderBy(asc(messages.sentAt), asc(findings.quoteStart), asc(changeOrderCreationOrder)),
  ]);

  const [projectRow] = projectRows;
  if (!projectRow) return null;
  return assembleWorkspace(projectRow, scopeRows, messageRows, findingRows, orderRows);
}

// Builds the screen data from rows already in screen order (see getWorkspace).
function assembleWorkspace(
  projectRow: Project,
  scopeRows: readonly ScopeItem[],
  messageRows: readonly Message[],
  findingRows: readonly Finding[],
  orderRows: readonly ChangeOrder[],
): WorkspaceData {
  // Field by field, so a row with bookkeeping columns (the in-memory seed has created_at) never passes them on.
  const project: Project = {
    id: projectRow.id,
    clientName: projectRow.clientName,
    clientEmail: projectRow.clientEmail,
    title: projectRow.title,
    hourlyRateCents: projectRow.hourlyRateCents,
    hoursPerDay: projectRow.hoursPerDay,
    agreedOn: projectRow.agreedOn,
    dueOn: projectRow.dueOn,
  };
  const items: ScopeItem[] = scopeRows.map((s) => ({
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    amountCents: s.amountCents,
    position: s.position,
  }));
  const orders: ChangeOrder[] = orderRows.map((o) => ({ ...o }));
  const findingsByMessage = new Map<string, Finding[]>();
  for (const f of findingRows) {
    const list = findingsByMessage.get(f.messageId) ?? [];
    list.push({ ...f });
    findingsByMessage.set(f.messageId, list);
  }

  const thread = messageRows.map((m) => {
    const message: Message = { id: m.id, projectId: m.projectId, from: m.from, author: m.author, sentAt: m.sentAt, body: m.body };
    const messageFindings = (findingsByMessage.get(m.id) ?? []).map((finding) => ({
      finding,
      order: displayedOrder(orders.filter((o) => o.findingId === finding.id)),
    }));
    return { ...message, findings: messageFindings };
  });

  return {
    project,
    scopeItems: items,
    messages: thread,
    changeOrders: orders,
    totals: projectTotals(items, orders),
  };
}

// The seed as the screen would show a fresh copy, built in memory: nothing is written and no row exists.
// Used when a new copy is refused (demo-limit.ts), so the first screen still shows the demo. demoRows lists the
// seed in the order getWorkspace reads it back; a test compares this with a real copy's first screen.
export function previewWorkspace(projectId: string, now: Date): WorkspaceData {
  const rows = demoRows(projectId, now);
  return assembleWorkspace(
    rows.project,
    rows.scopeItems,
    rows.messages,
    rows.findings,
    rows.changeOrders.map((o) => ({
      ...o,
      paypalInvoiceId: o.paypalInvoiceId ?? null,
      payerViewUrl: o.payerViewUrl ?? null,
      sentAt: o.sentAt ?? null,
      paidAt: o.paidAt ?? null,
    })),
  );
}

export interface VisitorWorkspace {
  data: WorkspaceData;
  // True when the visitor has no copy and a new one was refused: data is previewWorkspace, and actions on it
  // answer not_found, since no row exists.
  preview: boolean;
}

export interface OpenVisitorWorkspaceOptions {
  mayCreate?: MayCreateCopy; // see demo-limit.ts; without it every new visitor gets a copy
  read?: typeof getWorkspace; // tests replace it to step into the cleanup race
}

// The visitor's workspace, creating their copy on the first visit. Another visitor's cleanup can delete a
// copy unused for seven days between ensuring it and reading it; then the copy is made once more, not a 500.
export async function openVisitorWorkspace(
  db: Db,
  visitorId: string,
  now: Date,
  { mayCreate, read = getWorkspace }: OpenVisitorWorkspaceOptions = {},
): Promise<VisitorWorkspace> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { projectId, refused } = await ensureDemoCopy(db, visitorId, now, mayCreate);
    if (refused) return { data: previewWorkspace(projectId, now), preview: true };
    const data = await read(db, projectId);
    if (data) return { data, preview: false };
  }
  throw new Error("demo copy missing after ensure");
}
