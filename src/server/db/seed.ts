import { eq, inArray } from "drizzle-orm";
import { locateFindings } from "../../domain/finding";
import { extraDaysForHours, priceForHours } from "../../domain/money";
import type { Db } from "./client";
import { changeOrders, findings, messages, projects, scopeItems } from "./schema";

// The demo project judges see first. Harbor & Pine Coffee and Maya Lindqvist are fictional.
export const DEMO_PROJECT_ID = "demo";

const RATE_CENTS = 5000; // $50 an hour
const HOURS_PER_DAY = 6;

const demoMessages = [
  {
    id: "demo-m1",
    projectId: DEMO_PROJECT_ID,
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-21T08:12:00Z",
    body: "Hi! Excited to get started. As we discussed: a landing page, our menu with online ordering, and a contact form. We'd love to launch by November 15.",
  },
  {
    id: "demo-m2",
    projectId: DEMO_PROJECT_ID,
    from: "me",
    author: "You",
    sentAt: "2026-10-21T09:30:00Z",
    body: "Thanks Maya. Sending the quote for those three pages now, with launch on November 15.",
  },
  {
    id: "demo-m3",
    projectId: DEMO_PROJECT_ID,
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-24T15:05:00Z",
    body: "Quick one: could we sell gift cards on the site too? Holiday season is coming.",
  },
  {
    id: "demo-m4",
    projectId: DEMO_PROJECT_ID,
    from: "client",
    author: "Maya Lindqvist",
    sentAt: "2026-10-28T11:40:00Z",
    body: "The menu looks great so far! Could you also add a loyalty page where customers log in to see their stamps? Our investors want it at launch.",
  },
] as const;

const demoFindingDrafts = [
  {
    id: "demo-f1",
    messageId: "demo-m3",
    quote: "sell gift cards on the site",
    title: "Gift card page",
    estimatedHours: 5,
    reason: "Gift card sales need their own page and checkout flow.",
  },
  {
    id: "demo-f2",
    messageId: "demo-m4",
    quote: "add a loyalty page where customers log in to see their stamps",
    title: "Loyalty page with customer login",
    estimatedHours: 13,
    reason:
      "Version 1 covers a landing page, the menu with ordering, and a contact form. Customer accounts aren't part of it.",
  },
];

// Offsets come from the same check the app runs on model output, so a typo in the demo text fails loudly.
function demoFindings() {
  return demoFindingDrafts.map(({ id, messageId, ...draft }) => {
    const body = demoMessages.find((m) => m.id === messageId)?.body ?? "";
    const [located] = locateFindings(body, [draft]);
    if (!located) throw new Error(`demo finding ${id} does not quote ${messageId}`);
    return { id, messageId, ...draft, quoteStart: located.start, quoteEnd: located.end };
  });
}

export async function seedDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete children explicitly so a reset never depends on the connection's foreign_keys setting.
    const demoMessageIds = tx.select({ id: messages.id }).from(messages).where(eq(messages.projectId, DEMO_PROJECT_ID));
    await tx.delete(changeOrders).where(eq(changeOrders.projectId, DEMO_PROJECT_ID));
    await tx.delete(findings).where(inArray(findings.messageId, demoMessageIds));
    await tx.delete(messages).where(eq(messages.projectId, DEMO_PROJECT_ID));
    await tx.delete(scopeItems).where(eq(scopeItems.projectId, DEMO_PROJECT_ID));
    await tx.delete(projects).where(eq(projects.id, DEMO_PROJECT_ID));

    await tx.insert(projects).values({
      id: DEMO_PROJECT_ID,
      clientName: "Harbor & Pine Coffee",
      clientEmail: "maya@harborandpine.example",
      title: "Online ordering site",
      hourlyRateCents: RATE_CENTS,
      hoursPerDay: HOURS_PER_DAY,
      agreedOn: "2026-10-21",
      dueOn: "2026-11-15",
      createdAt: "2026-10-21T09:00:00Z",
    });

    await tx.insert(scopeItems).values([
      { id: "demo-s1", projectId: DEMO_PROJECT_ID, title: "Landing page", amountCents: 90000, position: 1 },
      { id: "demo-s2", projectId: DEMO_PROJECT_ID, title: "Menu with online ordering", amountCents: 120000, position: 2 },
      { id: "demo-s3", projectId: DEMO_PROJECT_ID, title: "Contact form", amountCents: 30000, position: 3 },
    ]);

    await tx.insert(messages).values([...demoMessages]);

    await tx.insert(findings).values(demoFindings());

    const order = (finding: (typeof demoFindingDrafts)[number], id: string) => ({
      id,
      projectId: DEMO_PROJECT_ID,
      findingId: finding.id,
      title: finding.title,
      hours: finding.estimatedHours,
      amountCents: priceForHours(finding.estimatedHours, RATE_CENTS),
      extraDays: extraDaysForHours(finding.estimatedHours, HOURS_PER_DAY),
    });

    await tx.insert(changeOrders).values([
      // Sample history: paid before this demo started, so it has no PayPal invoice of its own.
      { ...order(demoFindingDrafts[0], "demo-co1"), status: "paid", sentAt: "2026-10-24T16:00:00Z", paidAt: "2026-10-26T10:00:00Z" },
      { ...order(demoFindingDrafts[1], "demo-co2"), status: "draft" },
    ]);
  });
}
