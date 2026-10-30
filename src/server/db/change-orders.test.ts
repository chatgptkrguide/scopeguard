import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { waiveOwnedChangeOrder } from "./change-orders";
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
});
