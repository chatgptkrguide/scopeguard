import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { resetDemoCopy } from "./demo";
import { runMigrations } from "./migrate";
import { changeOrders } from "./schema";

// The database repeats the domain rules, so a write that skips change-order.ts still can't break them.
describe("DB 제약", () => {
  let db: Db;
  let draftId: string;
  let draftOrder: Omit<typeof changeOrders.$inferInsert, "id" | "status">;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    await resetDemoCopy(db, "p-test", new Date("2026-11-01T00:00:00Z"));
    const [draft] = await db
      .select()
      .from(changeOrders)
      .where(and(eq(changeOrders.projectId, "p-test"), eq(changeOrders.status, "draft")));
    draftId = draft.id;
    draftOrder = {
      projectId: "p-test",
      findingId: draft.findingId,
      title: draft.title,
      hours: draft.hours,
      amountCents: draft.amountCents,
      extraDays: draft.extraDays,
    };
  });

  it("목록에 없는 상태 값은 거부한다", async () => {
    await expect(db.update(changeOrders).set({ status: "refunded" as "paid" }).where(eq(changeOrders.id, draftId))).rejects.toThrow();
  });

  it("음수 금액과 0 이하 시간은 거부한다", async () => {
    await expect(db.update(changeOrders).set({ amountCents: -500 }).where(eq(changeOrders.id, draftId))).rejects.toThrow();
    await expect(db.update(changeOrders).set({ hours: 0 }).where(eq(changeOrders.id, draftId))).rejects.toThrow();
  });

  it("청구서 번호 없이 발송 상태가 될 수 없다", async () => {
    await expect(
      db.update(changeOrders).set({ status: "sent", sentAt: "2026-11-02T10:00:00Z" }).where(eq(changeOrders.id, draftId)),
    ).rejects.toThrow();
  });

  it("결제일 없이 결제 상태가 될 수 없다", async () => {
    await expect(
      db
        .update(changeOrders)
        .set({ status: "paid", paypalInvoiceId: "INV2-TEST", sentAt: "2026-11-02T10:00:00Z" })
        .where(eq(changeOrders.id, draftId)),
    ).rejects.toThrow();
  });

  it("금액 0으로 발송되거나 발송보다 이른 결제일은 거부한다", async () => {
    const sent = { status: "sent" as const, paypalInvoiceId: "INV2-TEST", sentAt: "2026-11-02T10:00:00Z" };
    await expect(db.update(changeOrders).set({ ...sent, amountCents: 0 }).where(eq(changeOrders.id, draftId))).rejects.toThrow();
    await expect(
      db
        .update(changeOrders)
        .set({ ...sent, status: "paid", paidAt: "2026-11-01T10:00:00Z" })
        .where(eq(changeOrders.id, draftId)),
    ).rejects.toThrow();
  });

  it("같은 항목에 진행 중인 견적은 하나뿐이고, 취소된 뒤에는 다시 만들 수 있다", async () => {
    await expect(db.insert(changeOrders).values({ ...draftOrder, id: "dup", status: "draft" })).rejects.toThrow();

    await db
      .update(changeOrders)
      .set({ status: "cancelled", paypalInvoiceId: "INV2-OLD", sentAt: "2026-11-02T10:00:00Z" })
      .where(eq(changeOrders.id, draftId));
    await db.insert(changeOrders).values({ ...draftOrder, id: "requote", status: "draft" });

    const rows = await db.select().from(changeOrders).where(eq(changeOrders.findingId, draftOrder.findingId));
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "draft"]);
  });
});
