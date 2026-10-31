import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_ID, INVOICE_ID, PAYER_VIEW_URL, WEBHOOK_ID, paidEvent, signatureHeaders } from "../../test/paypal-fixtures";
import type { BillingDeps, InvoiceGateway } from "./billing";
import { listActivity } from "./db/activity";
import { createDb, type Db } from "./db/client";
import { ensureDemoCopy } from "./db/demo";
import { runMigrations } from "./db/migrate";
import { getWorkspace } from "./db/queries";
import { changeOrders } from "./db/schema";
import { checkOwnedPayment } from "./payments";
import { PayPalError } from "./paypal/errors";
import type { InvoiceView } from "./paypal/invoices";
import { receivePayPalWebhook } from "./webhook";

const T0 = new Date("2026-11-01T09:00:00.000Z");

// A PayPal stand-in for reading invoices back; every other call fails the test.
function fakeInvoices(view: (id: string) => Promise<InvoiceView>) {
  const calls: string[] = [];
  const unused = async () => Promise.reject(new Error("not used when checking a payment"));
  const gateway: InvoiceGateway = {
    create: unused,
    send: unused,
    cancel: unused,
    get: async (id) => {
      calls.push(id);
      return view(id);
    },
  };
  return { gateway, calls };
}

describe("결제 확인 (Check payment)", () => {
  let db: Db;
  let mine: string;
  let theirs: string;
  let orderId: string;

  const invoiceView = (status: string, overrides: Partial<InvoiceView> = {}): InvoiceView => ({
    id: INVOICE_ID,
    status,
    invoiceNumber: "TG-4ILUBN7LCCN6SKDSN5C15S",
    reference: orderId,
    amountValue: "650.00",
    currencyCode: "USD",
    payerViewUrl: PAYER_VIEW_URL,
    ...overrides,
  });

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    mine = (await ensureDemoCopy(db, "visitor-a", T0)).projectId;
    theirs = (await ensureDemoCopy(db, "visitor-b", T0)).projectId;
    const [draft] = await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, mine), eq(changeOrders.status, "draft")));
    orderId = draft.id;
    await db.update(changeOrders).set({ status: "sent", paypalInvoiceId: INVOICE_ID, sentAt: "2026-11-01T08:00:00.000Z", payerViewUrl: PAYER_VIEW_URL }).where(eq(changeOrders.id, orderId));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  const deps = (gateway: InvoiceGateway | null, now = () => T0): BillingDeps => ({ db, paypal: gateway, now });
  const order = async () => (await db.select().from(changeOrders).where(eq(changeOrders.id, orderId)))[0];
  const kinds = async () => (await listActivity(db, mine)).filter((e) => e.changeOrderId === orderId).map((e) => e.kind);

  it("결제 확인을 누르면 PayPal이 PAID일 때 sent 견적이 paid가 되고 합계의 결제됨에 들어간다", async () => {
    const paypal = fakeInvoices(async () => invoiceView("PAID"));
    const paidBefore = (await getWorkspace(db, mine))!.totals.paidCents;

    const result = await checkOwnedPayment(deps(paypal.gateway), mine, orderId);

    expect(result).toEqual({ ok: true });
    expect(paypal.calls).toEqual([INVOICE_ID]);
    expect(await order()).toMatchObject({ status: "paid", paidAt: T0.toISOString() });
    expect((await getWorkspace(db, mine))!.totals.paidCents).toBe(paidBefore + 65000);
    expect(await kinds()).toEqual(["payment_confirmed"]);
    expect((await listActivity(db, mine)).at(-1)?.detail).toMatchObject({ source: "check", eventId: null, paypalStatus: "PAID" });
  });

  it("PayPal이 SENT면 not_paid_yet을 돌려주고 견적과 활동 기록이 그대로다", async () => {
    const before = await order();

    const result = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("SENT")).gateway), mine, orderId);

    expect(result).toEqual({ ok: false, error: "not_paid_yet" });
    expect(await order()).toEqual(before);
    expect(await kinds()).toEqual([]);
  });

  it("부분·보류 결제면 not_paid_yet이고 sent를 유지한다", async () => {
    const partly = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("PARTIALLY_PAID")).gateway), mine, orderId);
    const pending = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("PAYMENT_PENDING")).gateway), mine, orderId);

    expect([partly, pending]).toEqual(Array(2).fill({ ok: false, error: "not_paid_yet" }));
    expect((await order()).status).toBe("sent");
  });

  it("다른 사본의 견적 id로 누르면 not_found이고 PayPal을 부르지 않는다", async () => {
    const paypal = fakeInvoices(async () => invoiceView("PAID"));

    const result = await checkOwnedPayment(deps(paypal.gateway), theirs, orderId);

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(paypal.calls).toEqual([]);
    expect((await order()).status).toBe("sent");
  });

  it("이미 paid면 PayPal을 부르지 않고 성공을 돌려준다", async () => {
    const paypal = fakeInvoices(async () => invoiceView("PAID"));
    await checkOwnedPayment(deps(paypal.gateway), mine, orderId);

    const again = await checkOwnedPayment(deps(paypal.gateway), mine, orderId);

    expect(again).toEqual({ ok: true });
    expect(paypal.calls).toHaveLength(1);
    expect(await kinds()).toEqual(["payment_confirmed"]);
  });

  it("웹훅과 결제 확인이 동시에 와도 상태 변화와 payment_confirmed 기록은 한 번이다", async () => {
    let reads = 0;
    let bothRead!: () => void;
    const gate = new Promise<void>((resolve) => (bothRead = resolve));
    const paypal = fakeInvoices(async () => {
      if (++reads === 2) bothRead();
      await gate; // both have read the order as sent before either writes
      return invoiceView("PAID");
    });
    const verifier = { verify: async () => "verified" as const };
    const request = new Request("https://tollgate.example/api/webhooks/paypal", { method: "POST", body: JSON.stringify(paidEvent(INVOICE_ID, orderId)), headers: signatureHeaders });

    const [webhook, check] = await Promise.all([
      receivePayPalWebhook({ db, paypal: paypal.gateway, verifier, webhookId: WEBHOOK_ID, now: () => T0 }, request),
      checkOwnedPayment(deps(paypal.gateway), mine, orderId),
    ]);

    expect(reads).toBe(2);
    expect(webhook).toEqual({ status: 200, outcome: "settled" });
    expect(check).toEqual({ ok: true });
    expect((await order()).status).toBe("paid");
    expect(await kinds()).toEqual(["payment_confirmed"]);
    expect(await db.query.webhookEvents.findMany()).toMatchObject([{ id: EVENT_ID, outcome: "settled" }]);
  });

  it("PayPal 조회가 실패하면 paypal_unavailable이고 활동 기록에 read 단계 실패가 남는다", async () => {
    const paypal = fakeInvoices(async () => Promise.reject(new PayPalError("unavailable", 503, null, "d07c9a1e6b3f5")));

    const result = await checkOwnedPayment(deps(paypal.gateway), mine, orderId);

    expect(result).toEqual({ ok: false, error: "paypal_unavailable" });
    expect((await order()).status).toBe("sent");
    expect((await listActivity(db, mine)).at(-1)).toMatchObject({
      kind: "paypal_failed",
      changeOrderId: orderId,
      detail: { step: "read", httpStatus: 503, issue: null, debugId: "d07c9a1e6b3f5" },
    });
  });

  it("PayPal이 조회를 거부하면 paypal_rejected다", async () => {
    const paypal = fakeInvoices(async () => Promise.reject(new PayPalError("rejected", 400, "INVALID_REQUEST", null)));

    expect(await checkOwnedPayment(deps(paypal.gateway), mine, orderId)).toEqual({ ok: false, error: "paypal_rejected" });
  });

  it("금액이나 통화가 다르면 invoice_changed이고 paid가 되지 않는다", async () => {
    const result = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("PAID", { amountValue: "600.00" })).gateway), mine, orderId);
    const otherCurrency = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("PAID", { currencyCode: "EUR" })).gateway), mine, orderId);

    expect(result).toEqual({ ok: false, error: "invoice_changed" });
    expect(otherCurrency).toEqual({ ok: false, error: "invoice_changed" });
    expect((await order()).status).toBe("sent");
    expect(await kinds()).toEqual([]);
  });

  it("서버 시계가 sent_at보다 앞이어도 paid_at은 sent_at보다 앞서지 않는다", async () => {
    const clockWentBack = () => new Date("2026-11-01T07:00:00.000Z"); // an hour before sent_at

    const result = await checkOwnedPayment(deps(fakeInvoices(async () => invoiceView("PAID")).gateway, clockWentBack), mine, orderId);

    expect(result).toEqual({ ok: true });
    expect(await order()).toMatchObject({ status: "paid", sentAt: "2026-11-01T08:00:00.000Z", paidAt: "2026-11-01T08:00:00.000Z" });
  });

  it("무료·취소된 견적과 청구서 없는 draft는 invalid_state이고 PayPal을 부르지 않는다", async () => {
    const paypal = fakeInvoices(async () => invoiceView("PAID"));
    await db.update(changeOrders).set({ status: "cancelled" }).where(eq(changeOrders.id, orderId));
    const cancelled = await checkOwnedPayment(deps(paypal.gateway), mine, orderId);
    await db.update(changeOrders).set({ status: "draft", paypalInvoiceId: null, sentAt: null, payerViewUrl: null }).where(eq(changeOrders.id, orderId));
    const bareDraft = await checkOwnedPayment(deps(paypal.gateway), mine, orderId);

    expect([cancelled, bareDraft]).toEqual(Array(2).fill({ ok: false, error: "invalid_state" }));
    expect(paypal.calls).toEqual([]);
  });

  it("PayPal 키가 없으면 not_configured다", async () => {
    expect(await checkOwnedPayment(deps(null), mine, orderId)).toEqual({ ok: false, error: "not_configured" });
  });
});
