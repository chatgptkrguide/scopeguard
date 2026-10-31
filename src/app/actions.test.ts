import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { ensureDemoCopy } from "@/server/db/demo";
import { runMigrations } from "@/server/db/migrate";
import { changeOrders, projects } from "@/server/db/schema";
import { newVisitorId, VISITOR_COOKIE } from "@/server/visitor";
import { resetDemo, waiveChangeOrder } from "./actions";

// Only the framework edges are replaced: the request's cookies, the router refresh, and which database to use.
const request = vi.hoisted(() => ({ cookies: new Map<string, string>(), db: null as Db | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/server/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/client")>()),
  getDb: () => {
    if (!request.db) throw new Error("test database not set");
    return request.db;
  },
}));

const NOW = new Date("2026-11-01T09:00:00.000Z");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("서버 액션: 무료 처리와 데모 재설정", () => {
  let db: Db;
  const me = newVisitorId();
  const someoneElse = newVisitorId();
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    request.db = db;
    request.cookies.clear();
    mine = (await ensureDemoCopy(db, me, NOW)).projectId;
    theirs = (await ensureDemoCopy(db, someoneElse, NOW)).projectId;
  });

  const signIn = (visitorId: string) => request.cookies.set(VISITOR_COOKIE, visitorId);
  const draftOf = async (projectId: string) =>
    (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, "draft"))))[0];
  const ordersOf = async (projectId: string) =>
    (await db.select().from(changeOrders).where(eq(changeOrders.projectId, projectId))).map((o) => [o.title, o.status, o.amountCents]);

  it("쿠키가 없으면 무료 처리·재설정 모두 DB를 바꾸지 않고 not_found를 돌려준다", async () => {
    const draft = await draftOf(mine);

    const waived = await waiveChangeOrder(null, form({ changeOrderId: draft.id }));
    const reset = await resetDemo(null, form({ projectId: mine }));

    expect(waived).toEqual({ ok: false, error: "not_found" });
    expect(reset).toEqual({ ok: false, error: "not_found" });
    expect((await draftOf(mine)).id).toBe(draft.id);
  });

  it("형식이 틀린 쿠키는 쿠키가 없는 것과 같다", async () => {
    request.cookies.set(VISITOR_COOKIE, "forged");
    const draft = await draftOf(mine);

    const result = await waiveChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect((await draftOf(mine)).status).toBe("draft");
  });

  it("폼에 amountCents·status를 함께 보내도 무시하고 상태만 waived가 된다", async () => {
    signIn(me);
    const draft = await draftOf(mine);

    const result = await waiveChangeOrder(
      null,
      form({ changeOrderId: draft.id, amountCents: "1", status: "paid", projectId: theirs }),
    );

    expect(result).toEqual({ ok: true });
    expect(await ordersOf(mine)).toEqual([
      ["Gift card page", "paid", 25000],
      ["Loyalty page with customer login", "waived", 65000],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("견적 id가 UUID 형식이 아니면 invalid_input이다", async () => {
    signIn(me);

    const results = [
      await waiveChangeOrder(null, form({ changeOrderId: "demo-co2" })),
      await waiveChangeOrder(null, form({ changeOrderId: "" })),
      await waiveChangeOrder(null, form({})),
    ];

    expect(results).toEqual(Array(3).fill({ ok: false, error: "invalid_input" }));
  });

  it("다른 사본의 견적 id로 무료 처리하면 not_found이고 그 견적은 그대로다", async () => {
    signIn(me);
    const theirDraft = await draftOf(theirs);

    const result = await waiveChangeOrder(null, form({ changeOrderId: theirDraft.id }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect((await draftOf(theirs)).id).toBe(theirDraft.id);
  });

  it("자기 사본 id로 재설정하면 시드 상태로 돌아가고 refresh를 한 번 부른다", async () => {
    signIn(me);
    await waiveChangeOrder(null, form({ changeOrderId: (await draftOf(mine)).id }));
    vi.mocked(refresh).mockClear();

    const result = await resetDemo(null, form({ projectId: mine }));

    expect(result).toEqual({ ok: true });
    expect(await ordersOf(mine)).toEqual([
      ["Gift card page", "paid", 25000],
      ["Loyalty page with customer login", "draft", 65000],
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("다른 사본의 id로 재설정하면 not_found이고 두 사본 모두 그대로다", async () => {
    signIn(me);
    await waiveChangeOrder(null, form({ changeOrderId: (await draftOf(theirs)).id }));
    await waiveChangeOrder(null, form({ changeOrderId: (await draftOf(mine)).id }));
    const before = await db.select().from(projects);
    const ordersBefore = [await ordersOf(mine), await ordersOf(theirs)];

    const result = await resetDemo(null, form({ projectId: theirs }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(projects)).toEqual(before);
    expect([await ordersOf(mine), await ordersOf(theirs)]).toEqual(ordersBefore);
  });

  it("형식이 틀린 프로젝트 id로 재설정하면 invalid_input이다", async () => {
    signIn(me);

    const results = [
      await resetDemo(null, form({ projectId: "demo" })),
      await resetDemo(null, form({ projectId: `${mine}x` })),
      await resetDemo(null, form({})),
    ];

    expect(results).toEqual(Array(3).fill({ ok: false, error: "invalid_input" }));
  });

  it("재설정 중 DB 오류가 나면 던지지 않고 server_error를 돌려주며 사본은 그대로다", async () => {
    signIn(me);
    await waiveChangeOrder(null, form({ changeOrderId: (await draftOf(mine)).id }));
    vi.mocked(refresh).mockClear();
    const ordersBefore = await ordersOf(mine);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // The reset batch fails on its fourth statement, after it already deleted change orders.
    await db.run(sql`CREATE TRIGGER fail_reset BEFORE DELETE ON scope_items BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);

    const result = await resetDemo(null, form({ projectId: mine }));

    expect(result).toEqual({ ok: false, error: "server_error" });
    expect(await ordersOf(mine)).toEqual(ordersBefore);
    expect(refresh).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("resetting the demo copy failed", expect.anything());
  });

  it("무료 처리 중 DB에 닿지 못하면 던지지 않고 server_error를 돌려준다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    db.$client.close();

    const result = await waiveChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "server_error" });
    expect(refresh).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith("waiving a change order failed", expect.anything());
  });

  it("소유 확인에서 막힌 요청은 DB 오류와 다른 코드(not_found·invalid_input)를 돌려준다", async () => {
    signIn(me);
    db.$client.close(); // a refused request must not even need the database

    const results = [
      await resetDemo(null, form({ projectId: theirs })),
      await resetDemo(null, form({ projectId: "demo" })),
      await waiveChangeOrder(null, form({ changeOrderId: "not-a-uuid" })),
    ];

    expect(results).toEqual([
      { ok: false, error: "not_found" },
      { ok: false, error: "invalid_input" },
      { ok: false, error: "invalid_input" },
    ]);
  });

  it("실패하면 refresh를 부르지 않는다", async () => {
    signIn(me);
    const paid = (await db.select().from(changeOrders).where(eq(changeOrders.projectId, mine))).find((o) => o.status === "paid");

    await waiveChangeOrder(null, form({ changeOrderId: paid?.id ?? "" }));
    await waiveChangeOrder(null, form({ changeOrderId: "not-a-uuid" }));
    await waiveChangeOrder(null, form({ changeOrderId: (await draftOf(theirs)).id }));
    await resetDemo(null, form({ projectId: theirs }));

    expect(refresh).not.toHaveBeenCalled();
  });
});
