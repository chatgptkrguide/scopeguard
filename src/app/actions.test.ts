import { and, eq, sql } from "drizzle-orm";
import { refresh } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoiceNumberFor } from "@/domain/invoice";
import type { InvoiceGateway } from "@/server/billing";
import { createDb, type Db } from "@/server/db/client";
import { ensureDemoCopy } from "@/server/db/demo";
import { runMigrations } from "@/server/db/migrate";
import { changeOrders, projects } from "@/server/db/schema";
import { PayPalError } from "@/server/paypal/errors";
import { newVisitorId, VISITOR_COOKIE } from "@/server/visitor";
import { cancelChangeOrder, checkPayment, requoteChangeOrder, resetDemo, sendChangeOrder, waiveChangeOrder } from "./actions";

// Only the framework edges are replaced: the request's cookies, the router refresh, which database to use,
// and which PayPal to talk to (a stand-in; the real one is never called from unit tests).
const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  db: null as Db | null,
  paypal: null as InvoiceGateway | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = request.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("@/server/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/billing")>()),
  liveBillingDeps: () => {
    if (!request.db) throw new Error("test database not set");
    return { db: request.db, paypal: request.paypal, now: () => new Date() };
  },
}));
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

  it("PayPal 청구서 id가 있는 초안을 무료 처리하면 invoice_exists이고, 화면이 Send again으로 바뀌도록 refresh를 부른다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await db.update(changeOrders).set({ paypalInvoiceId: "INV2-DZQM-QREH-7LAT-F7YR" }).where(eq(changeOrders.id, draft.id));

    const result = await waiveChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "invoice_exists" });
    expect((await draftOf(mine)).id).toBe(draft.id);
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("발송된 견적이 있으면 재설정을 invoice_open으로 거부하고 견적을 지우지 않는다(화면은 새로 그린다)", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await db
      .update(changeOrders)
      .set({ status: "sent", paypalInvoiceId: "INV2-AAAA-BBBB-CCCC-DDDD", sentAt: NOW.toISOString() })
      .where(eq(changeOrders.id, draft.id));
    vi.mocked(refresh).mockClear();

    const result = await resetDemo(null, form({ projectId: mine }));

    expect(result).toEqual({ ok: false, error: "invoice_open" });
    expect(await ordersOf(mine)).toEqual([
      ["Gift card page", "paid", 25000],
      ["Loyalty page with customer login", "sent", 65000],
    ]);
    expect((await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0]?.paypalInvoiceId).toBe("INV2-AAAA-BBBB-CCCC-DDDD");
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
    // The reset batch fails on its fifth statement, after it already deleted activity and change orders.
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

describe("서버 액션: 발송·취소·다시 견적", () => {
  let db: Db;
  const me = newVisitorId();
  const someoneElse = newVisitorId();
  let mine: string;
  let theirs: string;
  let calls: { create: string[]; send: string[]; cancel: string[] };

  // A healthy sandbox stand-in that records what it was asked to bill.
  const created: { amountCents: number; email: string }[] = [];
  function healthyPayPal(): InvoiceGateway {
    return {
      create: async (input) => {
        calls.create.push(input.changeOrderId);
        created.push({ amountCents: input.amountCents, email: input.recipient.email });
        return { id: "INV2-DZQM-QREH-7LAT-F7YR", invoiceNumber: invoiceNumberFor(input.changeOrderId), created: true };
      },
      send: async (id) => {
        calls.send.push(id);
        return "sent";
      },
      get: async (id) => ({ id, status: "SENT", invoiceNumber: null, reference: null, amountValue: "650.00", currencyCode: "USD", payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#DZQMQREH7LATF7YR" }),
      cancel: async (id) => {
        calls.cancel.push(id);
        return "cancelled";
      },
    };
  }

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    request.db = db;
    request.cookies.clear();
    calls = { create: [], send: [], cancel: [] };
    created.length = 0;
    request.paypal = healthyPayPal();
    mine = (await ensureDemoCopy(db, me, NOW)).projectId;
    theirs = (await ensureDemoCopy(db, someoneElse, NOW)).projectId;
  });

  const signIn = (visitorId: string) => request.cookies.set(VISITOR_COOKIE, visitorId);
  const draftOf = async (projectId: string) =>
    (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, "draft"))))[0];
  const statusOf = async (id: string) => (await db.select().from(changeOrders).where(eq(changeOrders.id, id)))[0]?.status;

  it("발송 액션은 폼의 changeOrderId만 읽고 amountCents·email 필드를 무시한다", async () => {
    signIn(me);
    const draft = await draftOf(mine);

    const result = await sendChangeOrder(
      null,
      form({ changeOrderId: draft.id, amountCents: "1", email: "attacker@evil.example", projectId: theirs, invoiceId: "INV2-AAAA-BBBB-CCCC-DDDD" }),
    );

    expect(result).toEqual({ ok: true });
    expect(created).toEqual([{ amountCents: 65000, email: "maya@harborandpine.example" }]);
    expect(await statusOf(draft.id)).toBe("sent");
    expect((await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0].paypalInvoiceId).toBe("INV2-DZQM-QREH-7LAT-F7YR");
  });

  it("발송이 성공하면 refresh를 한 번 부르고, 발송·취소가 실패하면 부르지 않는다", async () => {
    signIn(me);
    const draft = await draftOf(mine);

    const theirDraft = await draftOf(theirs);
    await sendChangeOrder(null, form({ changeOrderId: draft.id }));
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.mocked(refresh).mockClear();
    request.paypal = {
      ...healthyPayPal(),
      create: async () => Promise.reject(new PayPalError("unavailable", 503, null, null)),
      cancel: async () => Promise.reject(new PayPalError("unavailable", 503, null, null)),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failedCancel = await cancelChangeOrder(null, form({ changeOrderId: draft.id }));
    signIn(someoneElse);
    const failedSend = await sendChangeOrder(null, form({ changeOrderId: theirDraft.id }));

    expect([failedCancel, failedSend]).toEqual(Array(2).fill({ ok: false, error: "paypal_unavailable" }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("PayPal이 발송을 받았는데 확인하지 못하면(paypal_unconfirmed) 화면이 Send again으로 바뀌도록 refresh를 부른다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    request.paypal = { ...healthyPayPal(), get: async () => Promise.reject(new PayPalError("unavailable", null, null, null)) };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "paypal_unconfirmed" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await statusOf(draft.id)).toBe("draft");
  });

  it("발송하다 PayPal에서 취소된 청구서를 만나면(invoice_void) 화면이 Quote again으로 바뀌도록 refresh를 부른다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    request.paypal = { ...healthyPayPal(), get: async (id) => ({ id, status: "CANCELLED", invoiceNumber: null, reference: null, amountValue: "650.00", currencyCode: "USD", payerViewUrl: null }) };

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "invoice_void" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await statusOf(draft.id)).toBe("cancelled");
  });

  it("쿠키가 없으면 발송은 not_found이고 PayPal을 부르지 않는다", async () => {
    const draft = await draftOf(mine);

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(calls.create).toEqual([]);
    expect(await statusOf(draft.id)).toBe("draft");
  });

  it("견적 id가 UUID가 아니면 발송은 invalid_input이다", async () => {
    signIn(me);

    const results = [
      await sendChangeOrder(null, form({ changeOrderId: "demo-co2" })),
      await sendChangeOrder(null, form({ changeOrderId: "" })),
      await sendChangeOrder(null, form({})),
    ];

    expect(results).toEqual(Array(3).fill({ ok: false, error: "invalid_input" }));
    expect(calls.create).toEqual([]);
  });

  it("다른 사본의 견적 id로 발송하면 not_found이고 그 견적은 그대로다", async () => {
    signIn(me);
    const theirDraft = await draftOf(theirs);

    const result = await sendChangeOrder(null, form({ changeOrderId: theirDraft.id }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(calls.create).toEqual([]);
    expect(await statusOf(theirDraft.id)).toBe("draft");
  });

  it("PayPal 키가 없는 서버에서 발송하면 not_configured이고 refresh하지 않는다", async () => {
    signIn(me);
    request.paypal = null;
    const draft = await draftOf(mine);

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await statusOf(draft.id)).toBe("draft");
  });

  it("예상 못 한 예외는 server_error로 바뀌고 오류 원문이 브라우저로 가지 않는다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    request.paypal = { ...healthyPayPal(), create: async () => Promise.reject(new Error("socket hang up at 10.0.0.7 with debug 9f8e")) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "server_error" });
    expect(JSON.stringify(result)).not.toMatch(/socket|10\.0\.0\.7|9f8e/);
    expect(logged).toHaveBeenCalledWith("sending a change order failed", expect.any(Error));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("PayPal 오류의 issue·debug id는 브라우저로 가지 않고 코드만 간다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    request.paypal = { ...healthyPayPal(), send: async () => Promise.reject(new PayPalError("rejected", 422, "CANNOT_SEND_INVOICE", "f5a1c27e3b9d4")) };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "paypal_rejected" });
    expect(JSON.stringify(result)).not.toMatch(/CANNOT_SEND|f5a1c27e3b9d4|INV2/);
  });

  it("취소 액션은 폼의 changeOrderId만 읽는다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await sendChangeOrder(null, form({ changeOrderId: draft.id }));
    vi.mocked(refresh).mockClear();

    const result = await cancelChangeOrder(null, form({ changeOrderId: draft.id, invoiceId: "INV2-AAAA-BBBB-CCCC-DDDD", status: "paid" }));

    expect(result).toEqual({ ok: true });
    expect(calls.cancel).toEqual(["INV2-DZQM-QREH-7LAT-F7YR"]);
    expect(await statusOf(draft.id)).toBe("cancelled");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("쿠키가 없으면 취소·다시 견적 모두 not_found다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await sendChangeOrder(null, form({ changeOrderId: draft.id }));
    request.cookies.clear();

    const results = [await cancelChangeOrder(null, form({ changeOrderId: draft.id })), await requoteChangeOrder(null, form({ changeOrderId: draft.id }))];

    expect(results).toEqual([
      { ok: false, error: "not_found" },
      { ok: false, error: "not_found" },
    ]);
    expect(calls.cancel).toEqual([]);
    expect(await statusOf(draft.id)).toBe("sent");
  });

  it("취소·다시 견적도 UUID가 아닌 id는 invalid_input이다", async () => {
    signIn(me);

    const results = [await cancelChangeOrder(null, form({ changeOrderId: "x" })), await requoteChangeOrder(null, form({}))];

    expect(results).toEqual(Array(2).fill({ ok: false, error: "invalid_input" }));
  });

  it("다시 견적 액션은 취소된 견적의 항목에 새 draft를 만들고 refresh를 부른다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await sendChangeOrder(null, form({ changeOrderId: draft.id }));
    await cancelChangeOrder(null, form({ changeOrderId: draft.id }));
    vi.mocked(refresh).mockClear();

    const result = await requoteChangeOrder(null, form({ changeOrderId: draft.id, amountCents: "1" }));

    const fresh = await draftOf(mine);
    expect(result).toEqual({ ok: true });
    expect(fresh.id).not.toBe(draft.id);
    expect([fresh.findingId, fresh.amountCents]).toEqual([draft.findingId, 65000]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("다시 견적 중 DB에 닿지 못하면 server_error다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.$client.close();

    const result = await requoteChangeOrder(null, form({ changeOrderId: draft.id }));

    expect(result).toEqual({ ok: false, error: "server_error" });
  });

  it("결제 확인 액션은 견적 id 형식이 아니면 invalid_input이다", async () => {
    signIn(me);
    const reads: string[] = [];
    request.paypal = { ...healthyPayPal(), get: async (id) => (reads.push(id), Promise.reject(new Error("not expected"))) };

    const results = [await checkPayment(null, form({ changeOrderId: "not-a-uuid" })), await checkPayment(null, form({}))];

    expect(results).toEqual(Array(2).fill({ ok: false, error: "invalid_input" }));
    expect(reads).toEqual([]);
  });

  it("결제 확인 액션은 성공했을 때만 화면을 새로 고친다", async () => {
    signIn(me);
    const draft = await draftOf(mine);
    await sendChangeOrder(null, form({ changeOrderId: draft.id }));
    vi.mocked(refresh).mockClear();
    const view = (status: string) => ({ id: "INV2-DZQM-QREH-7LAT-F7YR", status, invoiceNumber: null, reference: draft.id, amountValue: "650.00", currencyCode: "USD", payerViewUrl: null });

    request.paypal = { ...healthyPayPal(), get: async () => view("SENT") };
    const notYet = await checkPayment(null, form({ changeOrderId: draft.id }));
    const refreshesBeforePaid = vi.mocked(refresh).mock.calls.length;
    request.paypal = { ...healthyPayPal(), get: async () => view("PAID") };
    const paid = await checkPayment(null, form({ changeOrderId: draft.id, amountCents: "1", status: "paid" }));

    expect(notYet).toEqual({ ok: false, error: "not_paid_yet" });
    expect(refreshesBeforePaid).toBe(0);
    expect(paid).toEqual({ ok: true });
    expect(await statusOf(draft.id)).toBe("paid");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("다른 사본의 견적으로 결제 확인을 누르면 not_found이고 PayPal을 부르지 않는다", async () => {
    signIn(me);
    const theirDraft = await draftOf(theirs);
    const reads: string[] = [];
    request.paypal = { ...healthyPayPal(), get: async (id) => (reads.push(id), Promise.reject(new Error("not expected"))) };

    const result = await checkPayment(null, form({ changeOrderId: theirDraft.id }));

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(reads).toEqual([]);
  });
});
