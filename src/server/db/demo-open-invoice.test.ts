import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { activityInsert } from "./activity";
import { SEND_CLAIM_TTL_MS } from "./change-orders";
import { createDb, type Db } from "./client";
import { DEMO_COPY_MAX_AGE_MS, deleteExpiredCopies, ensureDemoCopy, resetDemoCopy } from "./demo";
import { runMigrations } from "./migrate";
import { activityEvents, changeOrders, projects } from "./schema";

// A reset or the seven-day cleanup must never delete an order whose PayPal invoice the client may still pay: the
// payment webhook would then find no order and the payment would go unrecorded.

const T0 = new Date("2026-11-01T09:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const PAST_EXPIRY = DEMO_COPY_MAX_AGE_MS + 1;

let db: Db;
let projectId: string;
let draftId: string;

beforeEach(async () => {
  db = createDb(":memory:");
  await runMigrations(db);
  ({ projectId } = await ensureDemoCopy(db, "visitor-a", T0));
  const [draft] = await db
    .select({ id: changeOrders.id })
    .from(changeOrders)
    .where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, "draft")));
  draftId = draft.id;
});

const setDraft = (values: Partial<typeof changeOrders.$inferInsert>) => db.update(changeOrders).set(values).where(eq(changeOrders.id, draftId));
const markSent = () => setDraft({ status: "sent", paypalInvoiceId: "INV2-AAAA-BBBB-CCCC-DDDD", sentAt: T0.toISOString() });
const ordersOf = (id: string) => db.select().from(changeOrders).where(eq(changeOrders.projectId, id)).orderBy(changeOrders.id);
const projectOf = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0];

describe("열린 청구서가 있는 사본의 재설정", () => {
  it("발송된 견적이 있으면 invoice_open으로 거부하고 견적·활동·프로젝트 행을 그대로 둔다", async () => {
    await markSent();
    await db.insert(activityEvents).values({ projectId, changeOrderId: draftId, kind: "invoice_sent", actor: "paypal", summary: "Sent", detail: null, at: T0.toISOString() });
    const before = { orders: await ordersOf(projectId), activity: await db.select().from(activityEvents), project: await projectOf(projectId) };

    const result = await resetDemoCopy(db, projectId, later(60_000));

    expect(result).toBe("invoice_open");
    expect(await ordersOf(projectId)).toEqual(before.orders);
    expect(await db.select().from(activityEvents)).toEqual(before.activity);
    expect(await projectOf(projectId)).toEqual(before.project);
  });

  it("PayPal 청구서 id가 저장된 초안(발송이 중간에 멈춘 건)도 거부한다", async () => {
    await setDraft({ paypalInvoiceId: "INV2-AAAA-BBBB-CCCC-DDDD" });

    expect(await resetDemoCopy(db, projectId, later(60_000))).toBe("invoice_open");
    expect((await ordersOf(projectId)).map((o) => o.id)).toContain(draftId);
  });

  it("발송이 진행 중인 초안은 거부하고, 2분이 지나 버려진 발송 표시는 막지 않는다", async () => {
    await setDraft({ sendClaimedAt: T0.toISOString() });

    expect(await resetDemoCopy(db, projectId, later(SEND_CLAIM_TTL_MS - 1))).toBe("invoice_open");
    expect(await resetDemoCopy(db, projectId, later(SEND_CLAIM_TTL_MS + 1))).toBe("reset");
    expect((await ordersOf(projectId)).map((o) => o.id)).not.toContain(draftId);
  });

  it("취소·무료 처리·결제된 견적만 있으면 재설정한다", async () => {
    await setDraft({ status: "cancelled", paypalInvoiceId: "INV2-AAAA-BBBB-CCCC-DDDD", sentAt: T0.toISOString() });
    await activityInsert(db, { projectId, changeOrderId: draftId, kind: "invoice_cancelled", actor: "paypal", summary: "Cancelled", detail: null, at: T0.toISOString() });

    expect(await resetDemoCopy(db, projectId, later(60_000))).toBe("reset");
    const orders = await ordersOf(projectId);
    expect(orders.map((o) => o.status).sort()).toEqual(["draft", "paid"]);
    expect(orders.map((o) => o.id)).not.toContain(draftId);
    expect(await db.select().from(activityEvents)).toEqual([]);
  });

  it("다른 사본의 열린 청구서는 이 사본의 재설정을 막지 않는다", async () => {
    await markSent();
    const other = await ensureDemoCopy(db, "visitor-b", T0);

    expect(await resetDemoCopy(db, other.projectId, later(60_000))).toBe("reset");
    expect(await resetDemoCopy(db, projectId, later(60_000))).toBe("invoice_open");
  });
});

describe("열린 청구서가 있는 사본의 7일 정리", () => {
  it("7일이 지나도 발송된 견적이 있는 사본은 남기고 세지 않는다", async () => {
    await markSent();
    const other = await ensureDemoCopy(db, "visitor-b", T0);

    const removed = await deleteExpiredCopies(db, later(PAST_EXPIRY));

    expect(removed).toBe(1);
    expect(await projectOf(other.projectId)).toBeUndefined();
    expect(await projectOf(projectId)).toBeDefined();
    expect((await ordersOf(projectId)).find((o) => o.id === draftId)?.status).toBe("sent");
  });

  it("그 견적이 결제되면 다음 정리에서 지운다", async () => {
    await markSent();
    await deleteExpiredCopies(db, later(PAST_EXPIRY));
    await setDraft({ status: "paid", paidAt: later(PAST_EXPIRY).toISOString() });

    expect(await deleteExpiredCopies(db, later(PAST_EXPIRY + 1))).toBe(1);
    expect(await projectOf(projectId)).toBeUndefined();
    expect(await ordersOf(projectId)).toEqual([]);
  });

  it("발송 진행 중인 초안이 있는 사본도 남긴다", async () => {
    await setDraft({ sendClaimedAt: later(PAST_EXPIRY - 1000).toISOString() });

    expect(await deleteExpiredCopies(db, later(PAST_EXPIRY))).toBe(0);
    expect(await projectOf(projectId)).toBeDefined();
  });
});
