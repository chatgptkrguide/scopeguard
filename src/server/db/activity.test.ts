import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { NewActivityEvent } from "../../domain/activity";
import { activityInsert, activityInsertAfterChange, listActivity } from "./activity";
import { createDb, type Db } from "./client";
import { DEMO_COPY_MAX_AGE_MS, deleteExpiredCopies, ensureDemoCopy, resetDemoCopy } from "./demo";
import { runMigrations } from "./migrate";
import { activityEvents, changeOrders } from "./schema";

const NOW = new Date("2026-11-01T09:00:00.000Z");

describe("활동 기록", () => {
  let db: Db;
  let mine: string;
  let theirs: string;
  let draftId: string;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    mine = (await ensureDemoCopy(db, "visitor-a", NOW)).projectId;
    theirs = (await ensureDemoCopy(db, "visitor-b", NOW)).projectId;
    draftId = (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, mine), eq(changeOrders.status, "draft"))))[0].id;
  });

  const event = (projectId: string, summary: string, at = NOW.toISOString()): NewActivityEvent => ({
    projectId,
    changeOrderId: null,
    kind: "invoice_created",
    actor: "paypal",
    summary,
    detail: { invoiceId: "INV2-DZQM-QREH-7LAT-F7YR", amount: "650.00", reused: false, httpStatus: null },
    at,
  });
  const allRows = () => db.select().from(activityEvents);

  it("기록은 넣은 순서대로 읽히고 detail은 원래 값으로 돌아온다", async () => {
    await activityInsert(db, event(mine, "first"));
    await activityInsert(db, { ...event(mine, "second"), changeOrderId: draftId });

    const events = await listActivity(db, mine);

    expect(events.map((e) => e.summary)).toEqual(["first", "second"]);
    expect(events[0].id).toBeLessThan(events[1].id);
    expect(events[0].detail).toEqual({ invoiceId: "INV2-DZQM-QREH-7LAT-F7YR", amount: "650.00", reused: false, httpStatus: null });
    expect(events[1].changeOrderId).toBe(draftId);
  });

  it("기록은 프로젝트별로만 읽히고 다른 사본의 기록은 보이지 않는다", async () => {
    await activityInsert(db, event(mine, "mine"));
    await activityInsert(db, event(theirs, "theirs"));

    const [forMe, forThem] = [await listActivity(db, mine), await listActivity(db, theirs)];

    expect(forMe.map((e) => e.summary)).toEqual(["mine"]);
    expect(forThem.map((e) => e.summary)).toEqual(["theirs"]);
  });

  it("재설정하면 그 사본의 활동 기록이 지워지고 다른 사본의 기록은 남는다", async () => {
    await activityInsert(db, { ...event(mine, "mine"), changeOrderId: draftId });
    await activityInsert(db, event(theirs, "theirs"));

    await resetDemoCopy(db, mine, NOW);

    expect(await listActivity(db, mine)).toEqual([]);
    expect((await listActivity(db, theirs)).map((e) => e.summary)).toEqual(["theirs"]);
  });

  it("7일 지난 사본을 지우면 그 사본의 활동 기록도 지워진다", async () => {
    await activityInsert(db, { ...event(mine, "old copy"), changeOrderId: draftId });
    await ensureDemoCopy(db, "visitor-b", new Date(NOW.getTime() + DEMO_COPY_MAX_AGE_MS)); // the other copy is opened again
    await activityInsert(db, event(theirs, "recent copy"));

    const removed = await deleteExpiredCopies(db, new Date(NOW.getTime() + DEMO_COPY_MAX_AGE_MS + 1));

    expect(removed).toBe(1);
    expect((await allRows()).map((r) => r.summary)).toEqual(["recent copy"]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("상태 변경 batch가 실패하면 활동 기록도 남지 않는다", async () => {
    // The status change fails on a CHECK constraint (sent without an invoice id), after the activity insert ran.
    const batch = db.batch([
      activityInsert(db, { ...event(mine, "sent"), kind: "invoice_sent", changeOrderId: draftId }),
      db.update(changeOrders).set({ status: "sent", sentAt: NOW.toISOString() }).where(eq(changeOrders.id, draftId)),
    ]);

    await expect(batch).rejects.toThrow();
    expect(await allRows()).toEqual([]);
    expect((await db.select().from(changeOrders).where(eq(changeOrders.id, draftId)))[0].status).toBe("draft");
  });

  it("바로 앞 UPDATE가 행을 바꿨을 때만 조건부 기록이 남는다", async () => {
    const waive = () => db.update(changeOrders).set({ status: "waived" }).where(and(eq(changeOrders.id, draftId), eq(changeOrders.status, "draft")));

    await db.batch([waive(), activityInsertAfterChange(db, event(mine, "changed"))]);
    await db.batch([waive(), activityInsertAfterChange(db, event(mine, "nothing changed"))]);

    expect((await listActivity(db, mine)).map((e) => [e.summary, e.detail])).toEqual([
      ["changed", { invoiceId: "INV2-DZQM-QREH-7LAT-F7YR", amount: "650.00", reused: false, httpStatus: null }],
    ]);
  });
});
