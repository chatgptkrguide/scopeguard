import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEND_CLAIM_TTL_MS, waiveOwnedChangeOrder } from "./change-orders";
import { createDb, type Db } from "./client";
import { ensureDemoCopy } from "./demo";
import { runMigrations } from "./migrate";
import { changeOrders } from "./schema";

const NOW = new Date("2026-11-01T09:00:00.000Z");

describe("견적 무료 처리(소유 확인)", () => {
  let db: Db;
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    mine = (await ensureDemoCopy(db, "visitor-a", NOW)).projectId;
    theirs = (await ensureDemoCopy(db, "visitor-b", NOW)).projectId;
  });

  const orderOf = async (projectId: string, status: "draft" | "paid") => {
    const [row] = await db
      .select()
      .from(changeOrders)
      .where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, status)));
    return row;
  };
  const statusOf = async (id: string) =>
    (await db.select({ status: changeOrders.status }).from(changeOrders).where(eq(changeOrders.id, id)))[0]?.status;
  // SQLite counts every row a write changed on this connection (":memory:" has exactly one).
  const totalChanges = async () => (await db.get<{ n: number }>(sql`SELECT total_changes() AS n`)).n;

  it("초안 견적을 무료 처리하면 waived가 된다", async () => {
    const draft = await orderOf(mine, "draft");

    const result = await waiveOwnedChangeOrder(db, mine, draft.id);

    expect(result).toEqual({ ok: true });
    expect(await statusOf(draft.id)).toBe("waived");
  });

  it("다른 사본의 견적 id로 무료 처리하면 not_found이고 그 견적은 그대로다", async () => {
    const theirDraft = await orderOf(theirs, "draft");

    const result = await waiveOwnedChangeOrder(db, mine, theirDraft.id);

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await statusOf(theirDraft.id)).toBe("draft");
  });

  it("없는 견적 id는 not_found다", async () => {
    const result = await waiveOwnedChangeOrder(db, mine, "00000000-0000-4000-8000-000000000000");

    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("발송·결제·취소된 견적은 무료 처리할 수 없고 상태가 그대로다", async () => {
    const paid = await orderOf(mine, "paid");
    const sent = await orderOf(mine, "draft");
    await db
      .update(changeOrders)
      .set({ status: "sent", paypalInvoiceId: "INV2-SENT", sentAt: "2026-11-02T10:00:00Z" })
      .where(eq(changeOrders.id, sent.id));
    const cancelled = await orderOf(theirs, "draft");
    await db
      .update(changeOrders)
      .set({ status: "cancelled", paypalInvoiceId: "INV2-CANCELLED", sentAt: "2026-11-02T10:00:00Z" })
      .where(eq(changeOrders.id, cancelled.id));

    const results = [
      await waiveOwnedChangeOrder(db, mine, paid.id),
      await waiveOwnedChangeOrder(db, mine, sent.id),
      await waiveOwnedChangeOrder(db, theirs, cancelled.id),
    ];

    expect(results).toEqual(Array(3).fill({ ok: false, error: "invalid_state" }));
    expect([await statusOf(paid.id), await statusOf(sent.id), await statusOf(cancelled.id)]).toEqual(["paid", "sent", "cancelled"]);
  });

  it("같은 견적을 두 번 무료 처리해도 결과는 한 번과 같다", async () => {
    const draft = await orderOf(mine, "draft");
    await waiveOwnedChangeOrder(db, mine, draft.id);
    const before = await totalChanges();

    const again = await waiveOwnedChangeOrder(db, mine, draft.id);

    expect(again).toEqual({ ok: true });
    expect(await statusOf(draft.id)).toBe("waived");
    expect(await totalChanges()).toBe(before);
  });

  it("동시에 두 번 무료 처리해도 둘 다 ok이고 상태 변화는 한 번이다", async () => {
    const draft = await orderOf(mine, "draft");
    const before = await totalChanges();

    const results = await Promise.all([waiveOwnedChangeOrder(db, mine, draft.id), waiveOwnedChangeOrder(db, mine, draft.id)]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await statusOf(draft.id)).toBe("waived");
    expect((await totalChanges()) - before).toBe(1);
  });

  describe("PayPal 청구서가 있거나 발송 중인 초안 (P2-D1)", () => {
    const INVOICE = "INV2-V26G-W6TK-FWP3-5XKU";
    const setDraft = async (id: string, values: { paypalInvoiceId?: string; sendClaimedAt?: string }) =>
      db.update(changeOrders).set(values).where(eq(changeOrders.id, id));
    // The first read sees the order as it was a moment ago; the database has moved on since (another request wrote).
    const staleFirstRead = (row: { status: "draft"; paypalInvoiceId: null; sendClaimedAt: null }) =>
      vi.spyOn(db, "select").mockImplementationOnce((() => ({ from: () => ({ where: async () => [row] }) })) as unknown as Db["select"]);
    const cleanDraft = { status: "draft", paypalInvoiceId: null, sendClaimedAt: null } as const;

    it("청구서 id가 있는 초안은 무료 처리할 수 없고 invoice_exists이며 draft 그대로다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { paypalInvoiceId: INVOICE });

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: false, error: "invoice_exists" });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("발송 표시가 2분 안인 초안은 무료 처리할 수 없고 in_progress다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { sendClaimedAt: new Date(NOW.getTime() - SEND_CLAIM_TTL_MS + 1000).toISOString() });

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: false, error: "in_progress" });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("발송 표시가 2분 넘게 남은 초안(멈춘 요청, 청구서 id 없음)은 무료 처리할 수 있다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { sendClaimedAt: new Date(NOW.getTime() - SEND_CLAIM_TTL_MS - 1000).toISOString() });

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: true });
      expect(await statusOf(draft.id)).toBe("waived");
    });

    it("발송 표시가 만료돼도 청구서 id가 있으면 무료 처리할 수 없다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { paypalInvoiceId: INVOICE, sendClaimedAt: new Date(NOW.getTime() - SEND_CLAIM_TTL_MS - 1000).toISOString() });

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: false, error: "invoice_exists" });
    });

    it("경합: 읽은 뒤 발송이 청구서 id를 저장했으면 조건부 UPDATE가 막아 waived가 되지 않고 invoice_exists다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { paypalInvoiceId: INVOICE });
      staleFirstRead(cleanDraft);

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: false, error: "invoice_exists" });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("경합: 읽은 뒤 발송이 시작됐으면(발송 표시) 조건부 UPDATE가 막아 waived가 되지 않고 in_progress다", async () => {
      const draft = await orderOf(mine, "draft");
      await setDraft(draft.id, { sendClaimedAt: NOW.toISOString() });
      staleFirstRead(cleanDraft);

      const result = await waiveOwnedChangeOrder(db, mine, draft.id, NOW);

      expect(result).toEqual({ ok: false, error: "in_progress" });
      expect(await statusOf(draft.id)).toBe("draft");
    });
  });
});
