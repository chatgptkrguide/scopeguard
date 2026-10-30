import "server-only";
import { asc, eq } from "drizzle-orm";
import { displayedOrder, projectTotals, type WorkspaceData } from "@/domain/workspace";
import type { ChangeOrder, Finding, Message, Project, ScopeItem } from "@/domain/types";
import type { Db } from "./client";
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
      .orderBy(asc(messages.sentAt), asc(findings.quoteStart), asc(changeOrders.id)),
  ]);

  const [projectRow] = projectRows;
  if (!projectRow) return null;

  const project: Project = { ...projectRow };
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
