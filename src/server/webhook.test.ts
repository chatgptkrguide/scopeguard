import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVENT_ID,
  INVOICE_ID,
  PAYER_VIEW_URL,
  WEBHOOK_ID,
  fakeFetch,
  paidEvent,
  signatureHeaders,
  verifySuccess,
} from "../../test/paypal-fixtures";
import type { InvoiceGateway } from "./billing";
import { listActivity } from "./db/activity";
import { createDb, type Db } from "./db/client";
import { ensureDemoCopy } from "./db/demo";
import { runMigrations } from "./db/migrate";
import { changeOrders, webhookEvents } from "./db/schema";
import { parseEnv } from "./env";
import { PayPalError } from "./paypal/errors";
import type { InvoiceView } from "./paypal/invoices";
import { createPayPalClient, paypalConfig } from "./paypal/token";
import { verificationBody, verifyWebhookSignature, type Verification, type WebhookHeaders } from "./paypal/webhooks";
import { invoiceIdFromEvent, readBodyWithin, receivePayPalWebhook, type VerifyLimit, type WebhookDeps, type WebhookVerifier } from "./webhook";

const EVENT_TIME = new Date("2026-11-01T09:00:00.000Z"); // paidEvent's create_time
const RECEIVED = new Date(EVENT_TIME.getTime() + 5000);
const URL = "https://tollgate.example/api/webhooks/paypal";

function webhookRequest(body: string, headers: Readonly<Record<string, string>> = signatureHeaders): Request {
  return new Request(URL, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

// A verifier that answers as told and records what it was given.
function fakeVerifier(answer: () => Promise<Verification> = async () => "verified") {
  const calls: Array<{ webhookId: string; headers: WebhookHeaders; rawEvent: string }> = [];
  const verifier: WebhookVerifier = {
    verify: async (webhookId, headers, rawEvent) => {
      calls.push({ webhookId, headers, rawEvent });
      return answer();
    },
  };
  return { verifier, calls };
}

// PayPal's invoice as it reads back: matching the order unless told otherwise.
function fakeInvoices(view: (id: string) => Promise<InvoiceView>) {
  const calls: string[] = [];
  const unused = async () => Promise.reject(new Error("not used by the webhook"));
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

describe("PayPal 결제 웹훅", () => {
  let db: Db;
  let mine: string;
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
    mine = (await ensureDemoCopy(db, "visitor-a", EVENT_TIME)).projectId;
    const [draft] = await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, mine), eq(changeOrders.status, "draft")));
    orderId = draft.id;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // The loyalty-page order, sent with INVOICE_ID ($650).
  async function markSentOrder(sentAt = "2026-11-01T08:00:00.000Z"): Promise<void> {
    await db.update(changeOrders).set({ status: "sent", paypalInvoiceId: INVOICE_ID, sentAt, payerViewUrl: PAYER_VIEW_URL }).where(eq(changeOrders.id, orderId));
  }

  function deps(overrides: Partial<WebhookDeps> = {}, invoice: (id: string) => Promise<InvoiceView> = async () => invoiceView("PAID")) {
    const verify = fakeVerifier();
    const paypal = fakeInvoices(invoice);
    const base: WebhookDeps = { db, paypal: paypal.gateway, verifier: verify.verifier, webhookId: WEBHOOK_ID, now: () => RECEIVED };
    return { deps: { ...base, ...overrides }, verify, paypal };
  }

  const order = async () => (await db.select().from(changeOrders).where(eq(changeOrders.id, orderId)))[0];
  const events = async () => db.select().from(webhookEvents);
  const kinds = async () => (await listActivity(db, mine)).filter((e) => e.changeOrderId === orderId).map((e) => e.kind);
  const eventBody = (options: Parameters<typeof paidEvent>[2] = {}) => JSON.stringify(paidEvent(INVOICE_ID, orderId, options));

  it("서명이 확인된 결제 이벤트는 청구서를 다시 읽어 PAID면 sent 견적을 paid로 바꾸고 payment_confirmed 기록을 남긴다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps();

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 200, outcome: "settled" });
    expect(paypal.calls).toEqual([INVOICE_ID]);
    expect(await order()).toMatchObject({ status: "paid", paidAt: RECEIVED.toISOString() });
    expect(await kinds()).toEqual(["payment_confirmed"]);
    expect((await listActivity(db, mine)).at(-1)?.detail).toMatchObject({ invoiceId: INVOICE_ID, paypalStatus: "PAID", source: "webhook", eventId: EVENT_ID });
    expect(await events()).toEqual([
      { id: EVENT_ID, eventType: "INVOICING.INVOICE.PAID", invoiceId: INVOICE_ID, outcome: "settled", eventCreatedAt: EVENT_TIME.toISOString(), receivedAt: RECEIVED.toISOString(), processedAt: RECEIVED.toISOString() },
    ]);
    expect(console.log).toHaveBeenCalledWith(`paypal webhook ${EVENT_ID} INVOICING.INVOICE.PAID → settled (lag 5s)`);
  });

  it("서명 확인이 FAILURE면 400으로 거부하고 이벤트 기록·견적·청구서 조회를 건드리지 않는다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps({ verifier: fakeVerifier(async () => "unverified").verifier });

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 400, outcome: "unverified" });
    expect(paypal.calls).toEqual([]);
    expect(await events()).toEqual([]);
    expect((await order()).status).toBe("sent");
    expect(await kinds()).toEqual([]);
  });

  it("PAYPAL_WEBHOOK_ID가 없으면 503으로 거부하고 서명 확인 API를 부르지 않는다", async () => {
    await markSentOrder();
    const { deps: d, verify, paypal } = deps({ webhookId: null });

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));
    const noKeys = await receivePayPalWebhook({ ...d, webhookId: WEBHOOK_ID, verifier: null, paypal: null }, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 503, outcome: "not_configured" });
    expect(noKeys).toEqual({ status: 503, outcome: "not_configured" });
    expect(verify.calls).toEqual([]);
    expect(paypal.calls).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("서명 확인 API가 5xx·네트워크 오류면 503을 돌려주고 이벤트를 기록하지 않는다", async () => {
    await markSentOrder();
    const serverError = deps({ verifier: fakeVerifier(async () => Promise.reject(new PayPalError("unavailable", 503, null, "d07c9a1e6b3f5"))).verifier });
    const network = deps({ verifier: fakeVerifier(async () => Promise.reject(new PayPalError("unavailable", null, null, null))).verifier });
    const refusedKeys = deps({ verifier: fakeVerifier(async () => Promise.reject(new PayPalError("auth", 401, "invalid_token", null))).verifier });

    const replies = [
      await receivePayPalWebhook(serverError.deps, webhookRequest(eventBody())),
      await receivePayPalWebhook(network.deps, webhookRequest(eventBody())),
      await receivePayPalWebhook(refusedKeys.deps, webhookRequest(eventBody())),
    ];

    expect(replies).toEqual(Array(3).fill({ status: 503, outcome: "verify_unavailable" }));
    expect(await events()).toEqual([]);
    expect((await order()).status).toBe("sent");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("PayPal refused the app's credentials while verifying a webhook"), expect.any(PayPalError));
  });

  it("같은 이벤트 id가 다시 오면 200을 돌려주고 PayPal을 부르지 않으며 상태·활동 기록이 그대로다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps();
    await receivePayPalWebhook(d, webhookRequest(eventBody()));
    const before = { order: await order(), kinds: await kinds(), events: await events() };

    const again = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(again).toEqual({ status: 200, outcome: "duplicate" });
    expect(paypal.calls).toHaveLength(1);
    expect({ order: await order(), kinds: await kinds(), events: await events() }).toEqual(before);
  });

  it("모르는 청구서의 결제 이벤트는 200을 돌려주고 어떤 견적도 바꾸지 않는다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps();
    const before = await db.select().from(changeOrders);

    const reply = await receivePayPalWebhook(d, webhookRequest(JSON.stringify(paidEvent("INV2-ZZZZ-YYYY-XXXX-WWWW", orderId))));

    expect(reply).toEqual({ status: 200, outcome: "unknown_invoice" });
    expect(paypal.calls).toEqual([]);
    expect(await db.select().from(changeOrders)).toEqual(before);
    expect(await events()).toMatchObject([{ id: EVENT_ID, invoiceId: "INV2-ZZZZ-YYYY-XXXX-WWWW", outcome: "unknown_invoice" }]);
  });

  it("청구서가 PARTIALLY_PAID나 PAYMENT_PENDING이면 sent를 유지하고 이벤트만 not_settled로 기록한다", async () => {
    await markSentOrder();
    const partly = deps({}, async () => invoiceView("PARTIALLY_PAID"));
    const pending = deps({}, async () => invoiceView("PAYMENT_PENDING"));

    const replies = [
      await receivePayPalWebhook(partly.deps, webhookRequest(eventBody({ id: "WH-PARTLY-1" }))),
      await receivePayPalWebhook(pending.deps, webhookRequest(eventBody({ id: "WH-PENDING-1" }))),
    ];

    expect(replies).toEqual(Array(2).fill({ status: 200, outcome: "not_settled" }));
    expect((await order()).status).toBe("sent");
    expect(await kinds()).toEqual([]);
    expect((await events()).map((e) => [e.id, e.outcome])).toEqual([
      ["WH-PARTLY-1", "not_settled"],
      ["WH-PENDING-1", "not_settled"],
    ]);
  });

  it("청구서 id를 가진 draft의 청구서가 PAID면 sent를 거쳐 paid가 되고 invoice_sent·payment_confirmed가 순서대로 남는다", async () => {
    await db.update(changeOrders).set({ paypalInvoiceId: INVOICE_ID, sendClaimedAt: "2026-11-01T08:59:00.000Z" }).where(eq(changeOrders.id, orderId));
    const { deps: d } = deps();

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 200, outcome: "settled" });
    expect(await order()).toMatchObject({ status: "paid", sentAt: RECEIVED.toISOString(), paidAt: RECEIVED.toISOString(), payerViewUrl: PAYER_VIEW_URL, sendClaimedAt: null });
    expect(await kinds()).toEqual(["invoice_sent", "payment_confirmed"]);
    expect((await listActivity(db, mine)).find((e) => e.kind === "invoice_sent")?.detail).toMatchObject({ recovered: true, invoiceId: INVOICE_ID });
  });

  it("Content-Length 없이 64KB를 넘게 흘러 오는 본문도 413으로 거부하고 읽기를 멈춘다", async () => {
    const { deps: d, verify } = deps();
    const CHUNK = 16 * 1024;
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
    });
    const request = new Request(URL, { method: "POST", body: endless, headers: signatureHeaders, duplex: "half" } as RequestInit);

    const reply = await receivePayPalWebhook(d, request);

    expect(reply).toEqual({ status: 413, outcome: "too_large" });
    expect(request.headers.get("content-length")).toBeNull();
    expect(pulled).toBeLessThanOrEqual(64 * 1024 + 2 * CHUNK);
    expect(verify.calls).toEqual([]);
  });

  it("Content-Length가 64KB를 넘으면 본문을 읽지 않고 413이다", async () => {
    const { deps: d, verify } = deps();
    const request = webhookRequest(eventBody(), { ...signatureHeaders, "content-length": String(64 * 1024 + 1) });

    const reply = await receivePayPalWebhook(d, request);

    expect(reply).toEqual({ status: 413, outcome: "too_large" });
    expect(request.bodyUsed).toBe(false);
    expect(verify.calls).toEqual([]);
  });

  it("서명 헤더 다섯 개 중 하나라도 없으면 400이고 PayPal을 부르지 않는다", async () => {
    const { deps: d, verify, paypal } = deps();

    for (const name of Object.keys(signatureHeaders)) {
      const headers: Record<string, string> = { ...signatureHeaders };
      delete headers[name];
      expect(await receivePayPalWebhook(d, webhookRequest(eventBody(), headers)), name).toEqual({ status: 400, outcome: "bad_request" });
    }
    expect(verify.calls).toEqual([]);
    expect(paypal.calls).toEqual([]);
  });

  it("서명 확인 요청의 webhook_event는 받은 본문과 바이트 단위로 같다(공백·키 순서·유니코드 이스케이프 유지)", async () => {
    await markSentOrder();
    const fake = fakeFetch({ "POST /v1/notifications/verify-webhook-signature": { status: 200, body: verifySuccess } });
    const config = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "stand-in-client-id", PAYPAL_CLIENT_SECRET: "stand-in-client-secret-0123456789" }))!;
    const client = createPayPalClient(config, { fetch: fake.fetch });
    const verifier: WebhookVerifier = { verify: (id, h, raw) => verifyWebhookSignature(client, id, h, raw) };
    const { deps: d } = deps({ verifier });
    const raw = `{"summary":"caf\\u00e9 é",  "id":"${EVENT_ID}",\n "event_type":"INVOICING.INVOICE.PAID", "create_time":"2026-11-01T09:00:00.000Z",\n "resource":{"id":"${INVOICE_ID}","status":"PAID"}}`;

    const reply = await receivePayPalWebhook(d, webhookRequest(raw));

    const sent = fake.to("POST /v1/notifications/verify-webhook-signature")[0].body!;
    expect(reply).toEqual({ status: 200, outcome: "settled" });
    expect(sent.endsWith(`,"webhook_event":${raw}}`)).toBe(true);
    expect(sent).toBe(
      verificationBody(
        WEBHOOK_ID,
        {
          authAlgo: signatureHeaders["paypal-auth-algo"],
          certUrl: signatureHeaders["paypal-cert-url"],
          transmissionId: signatureHeaders["paypal-transmission-id"],
          transmissionSig: signatureHeaders["paypal-transmission-sig"],
          transmissionTime: signatureHeaders["paypal-transmission-time"],
        },
        raw,
      ),
    );
  });

  it("결제가 아닌 확인된 이벤트(INVOICING.INVOICE.SENT)는 200으로 ignored_type만 기록한다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps();

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody({ type: "INVOICING.INVOICE.SENT" })));

    expect(reply).toEqual({ status: 200, outcome: "ignored_type" });
    expect(paypal.calls).toEqual([]);
    expect(await events()).toMatchObject([{ id: EVENT_ID, eventType: "INVOICING.INVOICE.SENT", invoiceId: null, outcome: "ignored_type" }]);
    expect((await order()).status).toBe("sent");
  });

  it("청구서 다시 읽기가 실패하면 503이고 이벤트를 기록하지 않아 다시 온 이벤트가 처리된다", async () => {
    await markSentOrder();
    const failing = deps({}, async () => Promise.reject(new PayPalError("unavailable", 503, null, null)));
    const healthy = deps();

    const first = await receivePayPalWebhook(failing.deps, webhookRequest(eventBody()));
    const recorded = await events();
    const retry = await receivePayPalWebhook(healthy.deps, webhookRequest(eventBody()));

    expect(first).toEqual({ status: 503, outcome: "invoice_unavailable" });
    expect(recorded).toEqual([]);
    expect(retry).toEqual({ status: 200, outcome: "settled" });
    expect((await order()).status).toBe("paid");
  });

  it("reference·금액·통화가 견적과 다르면 paid로 바꾸지 않고 mismatch로 기록한다", async () => {
    await markSentOrder();
    const otherAmount = deps({}, async () => invoiceView("PAID", { amountValue: "600.00" }));
    const otherReference = deps({}, async () => invoiceView("PAID", { reference: "11111111-2222-4333-8444-555555555555" }));
    const otherCurrency = deps({}, async () => invoiceView("PAID", { currencyCode: "EUR" }));

    const replies = [
      await receivePayPalWebhook(otherAmount.deps, webhookRequest(eventBody({ id: "WH-AMOUNT-1" }))),
      await receivePayPalWebhook(otherReference.deps, webhookRequest(eventBody({ id: "WH-REFERENCE-1" }))),
      await receivePayPalWebhook(otherCurrency.deps, webhookRequest(eventBody({ id: "WH-CURRENCY-1" }))),
    ];

    expect(replies).toEqual(Array(3).fill({ status: 200, outcome: "mismatch" }));
    expect((await order()).status).toBe("sent");
    expect(await kinds()).toEqual([]);
    expect((await events()).map((e) => e.outcome)).toEqual(["mismatch", "mismatch", "mismatch"]);
  });

  it("같은 이벤트 두 개가 동시에 와도 상태 변화와 payment_confirmed 기록은 한 번이다", async () => {
    await markSentOrder();
    let reads = 0;
    let bothRead!: () => void;
    const gate = new Promise<void>((resolve) => (bothRead = resolve));
    const { deps: d } = deps({}, async () => {
      if (++reads === 2) bothRead();
      await gate; // both requests are past the duplicate check before either records
      return invoiceView("PAID");
    });

    const replies = await Promise.all([receivePayPalWebhook(d, webhookRequest(eventBody())), receivePayPalWebhook(d, webhookRequest(eventBody()))]);

    expect(reads).toBe(2);
    expect(replies).toContainEqual({ status: 200, outcome: "settled" });
    expect(replies).toContainEqual({ status: 200, outcome: "duplicate" });
    expect((await order()).status).toBe("paid");
    expect(await kinds()).toEqual(["payment_confirmed"]);
    expect(await events()).toHaveLength(1);
  });

  it("resource.id 모양과 resource.invoice.id 모양 모두에서 청구서 id를 읽는다", async () => {
    await markSentOrder();
    const { deps: d } = deps();

    const nested = await receivePayPalWebhook(d, webhookRequest(eventBody({ nested: true })));

    expect(invoiceIdFromEvent(paidEvent(INVOICE_ID, orderId))).toBe(INVOICE_ID);
    expect(invoiceIdFromEvent(paidEvent(INVOICE_ID, orderId, { nested: true }))).toBe(INVOICE_ID);
    expect(invoiceIdFromEvent({ resource: { id: "not-an-invoice" } })).toBeNull();
    expect(invoiceIdFromEvent({ resource: { invoice: { id: "INV2-../../x" }, id: "WH-1" } })).toBeNull();
    expect(nested).toEqual({ status: 200, outcome: "settled" });
  });

  it("확인된 PAID 이벤트에서 청구서 id를 찾지 못하면 500이고 기록하지 않는다", async () => {
    await markSentOrder();
    const { deps: d, paypal } = deps();
    const event = { ...paidEvent(INVOICE_ID, orderId), resource: { status: "PAID" } };

    const reply = await receivePayPalWebhook(d, webhookRequest(JSON.stringify(event)));

    expect(reply).toEqual({ status: 500, outcome: "no_invoice_id" });
    expect(paypal.calls).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("응답 본문과 로그에 요청 본문·서명 헤더·결제자 이메일이 들어가지 않는다", async () => {
    await markSentOrder();
    const body = eventBody();
    const scenarios = [
      deps(),
      deps({ verifier: fakeVerifier(async () => "unverified").verifier }),
      deps({ verifier: fakeVerifier(async () => Promise.reject(new PayPalError("unavailable", 503, null, "d07c9a1e6b3f5"))).verifier }),
      deps({}, async () => invoiceView("PAID", { amountValue: "1.00" })),
    ];

    const replies = [];
    for (const [i, s] of scenarios.entries()) replies.push(await receivePayPalWebhook(s.deps, webhookRequest(body.replace(EVENT_ID, `${EVENT_ID}-${i}`))));

    const logged = [console.log, console.warn, console.error]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat())
      .map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message}` : String(arg)))
      .join("\n");
    const output = `${JSON.stringify(replies)}\n${logged}`;
    expect(logged).not.toBe("");
    for (const secret of ["maya@harborandpine.example", signatureHeaders["paypal-transmission-sig"], signatureHeaders["paypal-cert-url"], signatureHeaders["paypal-transmission-id"], body]) {
      expect(output).not.toContain(secret);
    }
  });

  it("서명 확인 호출이 분당 상한을 넘으면 503과 Retry-After를 돌려주고 PayPal을 부르지 않는다", async () => {
    await markSentOrder();
    const verifyLimit: VerifyLimit = { max: 2, windowMs: 60_000, times: [] };
    const { deps: d, verify } = deps({ verifyLimit }, async () => invoiceView("SENT"));

    const replies = [];
    for (let i = 0; i < 3; i++) replies.push(await receivePayPalWebhook(d, webhookRequest(eventBody({ id: `WH-FLOOD-${i}` }))));
    const aMinuteLater = await receivePayPalWebhook({ ...d, now: () => new Date(RECEIVED.getTime() + 60_001) }, webhookRequest(eventBody({ id: "WH-FLOOD-3" })));

    expect(replies.slice(0, 2)).toEqual(Array(2).fill({ status: 200, outcome: "not_settled" }));
    expect(replies[2]).toEqual({ status: 503, outcome: "busy", retryAfterSeconds: 60 });
    expect(verify.calls.map((c) => JSON.parse(c.rawEvent).id)).toEqual(["WH-FLOOD-0", "WH-FLOOD-1", "WH-FLOOD-3"]);
    expect(aMinuteLater).toEqual({ status: 200, outcome: "not_settled" });
  });

  it("이미 paid인 견적의 이벤트는 PayPal을 부르지 않고 already_paid로 기록한다", async () => {
    const [paid] = await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, mine), eq(changeOrders.status, "paid")));
    await db.update(changeOrders).set({ paypalInvoiceId: INVOICE_ID }).where(eq(changeOrders.id, paid.id));
    const { deps: d, paypal } = deps();
    const before = await db.select().from(changeOrders).where(eq(changeOrders.id, paid.id));

    const reply = await receivePayPalWebhook(d, webhookRequest(JSON.stringify(paidEvent(INVOICE_ID, paid.id))));

    expect(reply).toEqual({ status: 200, outcome: "already_paid" });
    expect(paypal.calls).toEqual([]);
    expect(await db.select().from(changeOrders).where(eq(changeOrders.id, paid.id))).toEqual(before);
    expect(await events()).toMatchObject([{ outcome: "already_paid", invoiceId: INVOICE_ID }]);
  });

  it("청구서가 MARKED_AS_PAID면(PM 결정 D1) paid가 된다", async () => {
    await markSentOrder();
    const { deps: d } = deps({}, async () => invoiceView("MARKED_AS_PAID"));

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 200, outcome: "settled" });
    expect((await order()).status).toBe("paid");
    expect((await listActivity(db, mine)).at(-1)).toMatchObject({ kind: "payment_confirmed", detail: { paypalStatus: "MARKED_AS_PAID" } });
  });

  it("취소·무료 처리된 견적의 청구서 이벤트는 PayPal을 부르지 않고 order_closed로 기록한다", async () => {
    await markSentOrder();
    await db.update(changeOrders).set({ status: "cancelled" }).where(eq(changeOrders.id, orderId));
    const { deps: d, paypal } = deps();

    const reply = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(reply).toEqual({ status: 200, outcome: "order_closed" });
    expect(paypal.calls).toEqual([]);
    expect((await order()).status).toBe("cancelled");
  });

  it("JSON이 아니거나 이벤트 id·종류가 없는 본문, UTF-8이 아닌 본문은 400이고 서명 확인을 부르지 않는다", async () => {
    const { deps: d, verify } = deps();
    const bodies: Array<string | Uint8Array<ArrayBuffer>> = [
      "not json",
      "[]",
      JSON.stringify({ event_type: "INVOICING.INVOICE.PAID" }),
      JSON.stringify({ id: "WH 1", event_type: "INVOICING.INVOICE.PAID" }),
      JSON.stringify({ id: EVENT_ID }),
      new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    ];

    for (const body of bodies) {
      const request = new Request(URL, { method: "POST", body, headers: signatureHeaders });
      expect(await receivePayPalWebhook(d, request)).toEqual({ status: 400, outcome: "bad_request" });
    }
    expect(verify.calls).toEqual([]);
  });

  it("DB 오류로 기록하지 못하면 500이고, 다시 온 이벤트는 처리된다", async () => {
    await markSentOrder();
    const { deps: d } = deps();
    await db.run("ALTER TABLE webhook_events RENAME TO webhook_events_away");

    const broken = await receivePayPalWebhook(d, webhookRequest(eventBody()));
    await db.run("ALTER TABLE webhook_events_away RENAME TO webhook_events");
    const retry = await receivePayPalWebhook(d, webhookRequest(eventBody()));

    expect(broken).toEqual({ status: 500, outcome: "server_error" });
    expect(retry).toEqual({ status: 200, outcome: "settled" });
    expect(await kinds()).toEqual(["payment_confirmed"]);
  });
});

describe("웹훅 본문 읽기", () => {
  it("상한 안의 본문은 그대로 읽는다", async () => {
    const text = '{"a":"é"}';

    expect(await readBodyWithin(new Request(URL, { method: "POST", body: text }), 64)).toEqual({ ok: true, text });
  });

  it("상한을 1바이트라도 넘으면 too_large다(바이트로 센다)", async () => {
    expect(await readBodyWithin(new Request(URL, { method: "POST", body: "é".repeat(5) }), 9)).toEqual({ ok: false, outcome: "too_large" });
    expect(await readBodyWithin(new Request(URL, { method: "POST", body: "é".repeat(5) }), 10)).toMatchObject({ ok: true });
  });
});
