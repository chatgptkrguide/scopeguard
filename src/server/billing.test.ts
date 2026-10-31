import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoiceNumberFor } from "@/domain/invoice";
import {
  cancelOwnedChangeOrder,
  invoiceGateway,
  requoteOwnedChangeOrder,
  sendOwnedChangeOrder,
  SEND_CLAIM_TTL_MS,
  type BillingDeps,
  type InvoiceGateway,
} from "./billing";
import { listActivity } from "./db/activity";
import { waiveOwnedChangeOrder } from "./db/change-orders";
import { createDb, type Db } from "./db/client";
import { ensureDemoCopy } from "./db/demo";
import { runMigrations } from "./db/migrate";
import { activityEvents, changeOrders, projects } from "./db/schema";
import { parseEnv } from "./env";
import { PayPalError } from "./paypal/errors";
import {
  INVOICE_ID,
  PAYER_VIEW_URL,
  cancelledInvoice,
  createdDraft,
  duplicateInvoiceNumber,
  fakeFetch,
  invalidToken,
  searchResult,
  sendResponse,
  sentInvoice,
  tokenResponse,
  type FakeReply,
} from "../../test/paypal-fixtures";
import type { InvoiceInput, InvoiceView } from "./paypal/invoices";
import { createPayPalClient, paypalConfig } from "./paypal/token";

const T0 = new Date("2026-11-01T09:00:00.000Z");

// A clock that moves one second each time it is read, so every step gets its own time.
function steppingClock(start = T0) {
  let t = start.getTime();
  return {
    now: () => new Date((t += 1000)),
    set: (at: Date) => (t = at.getTime()),
  };
}

interface FakeBehavior {
  create?: (input: InvoiceInput) => Promise<{ id: string; invoiceNumber: string; created: boolean }>;
  send?: (invoiceId: string) => Promise<"sent" | "already_sent">;
  get?: (invoiceId: string) => Promise<InvoiceView>;
  cancel?: (invoiceId: string) => Promise<"cancelled" | "already_cancelled" | "paid">;
}

const sentView = (id: string, changeOrderId: string): InvoiceView => ({
  id,
  status: "SENT",
  invoiceNumber: invoiceNumberFor(changeOrderId),
  reference: changeOrderId,
  amountValue: "650.00",
  payerViewUrl: PAYER_VIEW_URL,
});

// A PayPal stand-in that answers like a healthy sandbox and counts every call.
function fakeGateway(behavior: FakeBehavior = {}) {
  const calls = { create: [] as InvoiceInput[], send: [] as string[], get: [] as string[], cancel: [] as string[] };
  const lastReference = { id: "" };
  const gateway: InvoiceGateway = {
    create: async (input) => {
      calls.create.push(input);
      lastReference.id = input.changeOrderId;
      return behavior.create ? behavior.create(input) : { id: INVOICE_ID, invoiceNumber: invoiceNumberFor(input.changeOrderId), created: true };
    },
    send: async (id) => {
      calls.send.push(id);
      return behavior.send ? behavior.send(id) : "sent";
    },
    get: async (id) => {
      calls.get.push(id);
      return behavior.get ? behavior.get(id) : sentView(id, lastReference.id);
    },
    cancel: async (id) => {
      calls.cancel.push(id);
      return behavior.cancel ? behavior.cancel(id) : "cancelled";
    },
  };
  const total = () => calls.create.length + calls.send.length + calls.get.length + calls.cancel.length;
  return { gateway, calls, total };
}

// The real invoice module and client over a fake fetch, for checks that need PayPal's actual answers.
const config = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "stand-in-client-id", PAYPAL_CLIENT_SECRET: "stand-in-client-secret-0123456789" }))!;
function realGateway(script: Readonly<Record<string, FakeReply | readonly FakeReply[]>>) {
  const fake = fakeFetch(script);
  return { ...fake, gateway: invoiceGateway(createPayPalClient(config, { fetch: fake.fetch })) };
}

describe("견적 발송·취소·다시 견적", () => {
  let db: Db;
  let mine: string;
  let theirs: string;
  let clock: ReturnType<typeof steppingClock>;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    mine = (await ensureDemoCopy(db, "visitor-a", T0)).projectId;
    theirs = (await ensureDemoCopy(db, "visitor-b", T0)).projectId;
    clock = steppingClock();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const deps = (paypal: InvoiceGateway | null): BillingDeps => ({ db, paypal, now: clock.now });
  const orderOf = async (projectId: string, status: "draft" | "paid") =>
    (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, status))))[0];
  const row = async (id: string) => (await db.select().from(changeOrders).where(eq(changeOrders.id, id)))[0];
  const kinds = async (projectId: string) => (await listActivity(db, projectId)).map((e) => e.kind);

  // A sent order in my copy, sent through the fake.
  async function sentOrder(): Promise<string> {
    const draft = await orderOf(mine, "draft");
    expect(await sendOwnedChangeOrder(deps(fakeGateway().gateway), mine, draft.id)).toEqual({ ok: true });
    return draft.id;
  }

  describe("발송", () => {
    it("초안 견적을 발송하면 sent가 되고 청구서 id·결제 링크·발송 시각이 저장된다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      const saved = await row(draft.id);
      expect(result).toEqual({ ok: true });
      expect(saved).toMatchObject({ status: "sent", paypalInvoiceId: INVOICE_ID, payerViewUrl: PAYER_VIEW_URL, sendClaimedAt: null });
      expect(saved.sentAt).toMatch(/^2026-11-01T09:00:\d\d\.000Z$/); // the stepping clock, after T0
      expect(saved.sentAt! > T0.toISOString()).toBe(true);
      expect([paypal.calls.create.length, paypal.calls.send, paypal.calls.get]).toEqual([1, [INVOICE_ID], [INVOICE_ID]]);
    });

    it("청구서 id는 PayPal 발송 전에 저장된다(발송이 실패해도 id가 남는다)", async () => {
      const draft = await orderOf(mine, "draft");
      let idWhenSending: string | null = null;
      const paypal = fakeGateway({
        send: async () => {
          idWhenSending = (await row(draft.id)).paypalInvoiceId;
          throw new PayPalError("unavailable", 503, null, "d07c9a1e6b3f5");
        },
      });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_unavailable" });
      expect(idWhenSending).toBe(INVOICE_ID);
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: INVOICE_ID, sendClaimedAt: null });
    });

    it("동시에 두 번 발송해도 청구서 작성은 한 번이고 둘 중 하나는 in_progress다", async () => {
      const draft = await orderOf(mine, "draft");
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const paypal = fakeGateway({
        create: async (input) => {
          await gate; // the first request waits inside PayPal while the second arrives
          return { id: INVOICE_ID, invoiceNumber: invoiceNumberFor(input.changeOrderId), created: true };
        },
      });

      const first = sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);
      const second = sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);
      const loser = await Promise.race([first, second]);
      openGate();
      const results = await Promise.all([first, second]);

      expect(loser).toEqual({ ok: false, error: "in_progress" });
      expect(results).toContainEqual({ ok: true });
      expect(results).toContainEqual({ ok: false, error: "in_progress" });
      expect(paypal.calls.create).toHaveLength(1);
      expect(paypal.calls.send).toHaveLength(1);
      expect((await row(draft.id)).status).toBe("sent");
    });

    it("같은 견적을 차례로 두 번 발송하면 두 번째는 PayPal을 부르지 않고 ok다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway();
      await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);
      const callsAfterFirst = paypal.total();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect(paypal.total()).toBe(callsAfterFirst);
    });

    it("다른 사본의 견적 id는 not_found이고 PayPal을 부르지 않는다", async () => {
      const theirDraft = await orderOf(theirs, "draft");
      const paypal = fakeGateway();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, theirDraft.id);

      expect(result).toEqual({ ok: false, error: "not_found" });
      expect(paypal.total()).toBe(0);
      expect(await row(theirDraft.id)).toMatchObject({ status: "draft", sendClaimedAt: null, paypalInvoiceId: null });
    });

    it("결제·무료·취소된 견적은 invalid_state이고 PayPal을 부르지 않는다", async () => {
      const paid = await orderOf(mine, "paid");
      const waived = await orderOf(theirs, "draft");
      await db.update(changeOrders).set({ status: "waived" }).where(eq(changeOrders.id, waived.id));
      const cancelledId = await sentOrder();
      await db.update(changeOrders).set({ status: "cancelled" }).where(eq(changeOrders.id, cancelledId));
      const paypal = fakeGateway();

      const results = [
        await sendOwnedChangeOrder(deps(paypal.gateway), mine, paid.id),
        await sendOwnedChangeOrder(deps(paypal.gateway), theirs, waived.id),
        await sendOwnedChangeOrder(deps(paypal.gateway), mine, cancelledId),
      ];

      expect(results).toEqual(Array(3).fill({ ok: false, error: "invalid_state" }));
      expect(paypal.total()).toBe(0);
    });

    it("금액이 0인 견적은 invalid_state이고 PayPal을 부르지 않는다", async () => {
      const draft = await orderOf(mine, "draft");
      await db.update(changeOrders).set({ amountCents: 0 }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "invalid_state" });
      expect(paypal.total()).toBe(0);
      expect((await row(draft.id)).sendClaimedAt).toBeNull();
    });

    it("청구서 id는 있는데 draft인 견적을 다시 발송하면 새로 만들지 않고 그 청구서를 발송한다", async () => {
      const draft = await orderOf(mine, "draft");
      await db.update(changeOrders).set({ paypalInvoiceId: "INV2-V26G-W6TK-FWP3-5XKU" }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway({ get: async (id) => sentView(id, draft.id) });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect(paypal.calls.create).toHaveLength(0);
      expect(paypal.calls.send).toEqual(["INV2-V26G-W6TK-FWP3-5XKU"]);
      expect(await row(draft.id)).toMatchObject({ status: "sent", paypalInvoiceId: "INV2-V26G-W6TK-FWP3-5XKU" });
    });

    it("발송 표시가 2분 넘게 남아 있으면 다음 요청이 이어받는다", async () => {
      const draft = await orderOf(mine, "draft");
      // A request that died 2 minutes and 1 second ago left its claim behind.
      const abandoned = new Date(T0.getTime() - SEND_CLAIM_TTL_MS - 1000).toISOString();
      await db.update(changeOrders).set({ sendClaimedAt: abandoned }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect(paypal.calls.create).toHaveLength(1);
      expect(await row(draft.id)).toMatchObject({ status: "sent", sendClaimedAt: null });
    });

    it("발송 표시가 2분 안이면 in_progress이고 PayPal을 부르지 않는다", async () => {
      const draft = await orderOf(mine, "draft");
      const recent = new Date(T0.getTime() - SEND_CLAIM_TTL_MS + 5000).toISOString();
      await db.update(changeOrders).set({ sendClaimedAt: recent }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway();

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "in_progress" });
      expect(paypal.total()).toBe(0);
      expect((await row(draft.id)).sendClaimedAt).toBe(recent);
    });

    it("PayPal이 응답하지 않으면 paypal_unavailable이고 발송 표시가 풀리며 견적은 draft다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({
        create: async () => {
          throw new PayPalError("unavailable", null, null, null);
        },
      });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_unavailable" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: null, sendClaimedAt: null });
      expect(paypal.calls.send).toHaveLength(0);
    });

    it("PayPal이 거부하면 paypal_rejected이고 견적은 draft다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({
        send: async () => {
          throw new PayPalError("rejected", 422, "CANNOT_SEND_INVOICE", "f5a1c27e3b9d4");
        },
      });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_rejected" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", sendClaimedAt: null });
      expect((await listActivity(db, mine)).at(-1)?.summary).toBe("PayPal refused the request while sending the invoice (CANNOT_SEND_INVOICE); it wasn't sent.");
    });

    it("토큰·키 문제(auth)와 없는 청구서(not_found)는 paypal_unavailable로 알린다", async () => {
      const draft = await orderOf(mine, "draft");
      const auth = fakeGateway({ create: async () => Promise.reject(new PayPalError("auth", 401, "invalid_client", null)) });
      const missing = fakeGateway({ send: async () => Promise.reject(new PayPalError("not_found", 404, "RESOURCE_NOT_FOUND", null)) });

      const results = [await sendOwnedChangeOrder(deps(auth.gateway), mine, draft.id), await sendOwnedChangeOrder(deps(missing.gateway), mine, draft.id)];

      expect(results).toEqual([
        { ok: false, error: "paypal_unavailable" },
        { ok: false, error: "paypal_unavailable" },
      ]);
    });

    it("발송 뒤 PayPal이 already_sent를 돌려줘도 sent로 저장된다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({ send: async () => "already_sent" });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect((await row(draft.id)).status).toBe("sent");
      expect((await listActivity(db, mine)).at(-1)?.detail).toMatchObject({ alreadySent: true });
    });

    it("발송 뒤 조회한 PayPal 상태가 CANCELLED면 sent로 저장하지 않고 cancelled로 표시해 invoice_void다(다시 견적 가능, P2-D4)", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({ get: async (id) => ({ ...sentView(id, draft.id), status: "CANCELLED" }) });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "invoice_void" });
      expect(await row(draft.id)).toMatchObject({ status: "cancelled", paypalInvoiceId: INVOICE_ID, sendClaimedAt: null, sentAt: null });
      expect(await kinds(mine)).toEqual(["invoice_created", "invoice_cancelled"]);
      expect((await listActivity(db, mine)).at(-1)?.detail).toEqual({ invoiceId: INVOICE_ID, paypalStatus: "CANCELLED", voided: true });
    });

    it("결제 링크가 sandbox.paypal.com이 아니면 링크 없이 sent로 저장된다", async () => {
      const draft = await orderOf(mine, "draft");
      const oddLink = { ...sentInvoice, detail: { ...sentInvoice.detail, metadata: { ...sentInvoice.detail.metadata, recipient_view_url: "https://paypal.evil.example/invoice/p/#X" } } };
      const pp = realGateway({
        "POST /v2/invoicing/invoices": { status: 201, body: createdDraft },
        [`POST /v2/invoicing/invoices/${INVOICE_ID}/send`]: { status: 200, body: sendResponse },
        [`GET /v2/invoicing/invoices/${INVOICE_ID}`]: { status: 200, body: oddLink },
      });

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect(await row(draft.id)).toMatchObject({ status: "sent", paypalInvoiceId: INVOICE_ID, payerViewUrl: null });
    });

    it("PayPal 키가 없으면 not_configured이고 DB를 바꾸지 않는다", async () => {
      const draft = await orderOf(mine, "draft");
      const before = await db.select().from(changeOrders);

      const result = await sendOwnedChangeOrder(deps(null), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "not_configured" });
      expect(await db.select().from(changeOrders)).toEqual(before);
      expect(await db.select().from(activityEvents)).toEqual([]);
    });

    it("청구서 본문의 금액·수신인은 DB 값이다(프로젝트 고객 이메일, 견적 금액)", async () => {
      const draft = await orderOf(mine, "draft");
      await db.update(projects).set({ clientEmail: "owner@cafe.example", clientName: "Cafe Example" }).where(eq(projects.id, mine));
      const paypal = fakeGateway();

      await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(paypal.calls.create[0]).toEqual({
        changeOrderId: draft.id,
        title: "Loyalty page with customer login",
        description: "Estimated 13 h at $50/h",
        note: "Change order for Online ordering site. Not part of the agreed scope.",
        amountCents: 65000,
        recipient: { email: "owner@cafe.example", businessName: "Cafe Example" },
      });
    });

    it("시급으로 계산한 값보다 금액이 크면 항목 설명에 $10 올림을 적는다", async () => {
      const draft = await orderOf(mine, "draft");
      await db.update(changeOrders).set({ hours: 12.5, amountCents: 63000 }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway();

      await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(paypal.calls.create[0].description).toBe("Estimated 12.5 h at $50/h, rounded up to the next $10");
    });

    it("작성 뒤 id를 저장하지 못한 견적을 다시 발송하면 번호로 같은 청구서를 찾아 쓰고 reused true로 남긴다", async () => {
      const draft = await orderOf(mine, "draft");
      const earlier = { ...createdDraft, detail: { ...createdDraft.detail, reference: draft.id, invoice_number: invoiceNumberFor(draft.id) } };
      const pp = realGateway({
        "POST /v2/invoicing/invoices": { status: 422, body: duplicateInvoiceNumber },
        "POST /v2/invoicing/search-invoices": { status: 200, body: searchResult(earlier) },
        [`POST /v2/invoicing/invoices/${INVOICE_ID}/send`]: { status: 200, body: sendResponse },
        [`GET /v2/invoicing/invoices/${INVOICE_ID}`]: { status: 200, body: { ...sentInvoice, detail: { ...sentInvoice.detail, reference: draft.id } } },
      });

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      expect(result).toEqual({ ok: true });
      expect(pp.to("POST /v2/invoicing/invoices")).toHaveLength(1);
      expect(await row(draft.id)).toMatchObject({ status: "sent", paypalInvoiceId: INVOICE_ID });
      const [created] = await listActivity(db, mine);
      expect(created.kind).toBe("invoice_created");
      expect(created.detail).toMatchObject({ reused: true, invoiceId: INVOICE_ID });
      expect(created.summary).toBe(`Found the PayPal invoice from an earlier try: ${invoiceNumberFor(draft.id)}`);
    });

    it("처음 보는 이름의 422나 이름 없는 422로 작성이 거부되면 paypal_rejected이고 견적은 draft·청구서 id 없음이며 번호 검색도 하지 않는다", async () => {
      const draft = await orderOf(mine, "draft");
      const pp = realGateway({
        "POST /v2/invoicing/invoices": [
          { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SOME_NEW_RULE" }] } },
          { status: 422, body: "" },
        ],
        "POST /v2/invoicing/search-invoices": { status: 200, body: searchResult(createdDraft) },
      });

      const results = [await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id), await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id)];

      expect(results).toEqual([
        { ok: false, error: "paypal_rejected" },
        { ok: false, error: "paypal_rejected" },
      ]);
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: null, sendClaimedAt: null });
      expect(pp.to("POST /v2/invoicing/search-invoices")).toHaveLength(0);
      expect(pp.to("POST /v2/invoicing/invoices")).toHaveLength(2);
      expect(await kinds(mine)).toEqual(["paypal_failed", "paypal_failed"]);
    });

    it("발송이 처음 보는 이름의 422를 받으면 sent로 저장하지 않고 paypal_rejected다", async () => {
      const draft = await orderOf(mine, "draft");
      const pp = realGateway({
        "POST /v2/invoicing/invoices": { status: 201, body: createdDraft },
        [`POST /v2/invoicing/invoices/${INVOICE_ID}/send`]: { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INVOICE_SENT_ALREADY" }] } },
      });

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_rejected" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: INVOICE_ID, sentAt: null });
    });
  });

  describe("PayPal에서 취소됐거나 번호가 막힌 청구서 (P2-D4)", () => {
    const duplicateOf = (existing: object) => ({
      "POST /v2/invoicing/invoices": { status: 422, body: duplicateInvoiceNumber },
      "POST /v2/invoicing/search-invoices": { status: 200, body: searchResult(existing) },
    });
    const forDraft = <T extends typeof createdDraft>(invoice: T, draftId: string) => ({
      ...invoice,
      detail: { ...invoice.detail, reference: draftId, invoice_number: invoiceNumberFor(draftId) },
    });

    it("중복 번호인데 PayPal의 그 청구서가 CANCELLED면 견적을 cancelled로 표시하고 invoice_void이며, 다시 견적하면 새 번호로 발송된다", async () => {
      const draft = await orderOf(mine, "draft");
      const pp = realGateway(duplicateOf(forDraft(cancelledInvoice, draft.id)));

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);
      const requoted = await requoteOwnedChangeOrder(db, mine, draft.id);
      const fresh = await orderOf(mine, "draft");
      const resent = await sendOwnedChangeOrder(deps(fakeGateway().gateway), mine, fresh.id);

      expect(result).toEqual({ ok: false, error: "invoice_void" });
      expect(await row(draft.id)).toMatchObject({ status: "cancelled", paypalInvoiceId: null, sendClaimedAt: null });
      expect(pp.to(`POST /v2/invoicing/invoices/${INVOICE_ID}/send`)).toHaveLength(0);
      expect(requoted).toEqual({ ok: true });
      expect(invoiceNumberFor(fresh.id)).not.toBe(invoiceNumberFor(draft.id));
      expect(resent).toEqual({ ok: true });
    });

    it("중복 번호인데 PayPal의 그 청구서가 금액이 다른 DRAFT면(아무도 결제할 수 없음) cancelled로 표시하고 invoice_void다", async () => {
      const draft = await orderOf(mine, "draft");
      const pp = realGateway(duplicateOf({ ...forDraft(createdDraft, draft.id), amount: { currency_code: "USD", value: "600.00" } }));

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "invoice_void" });
      expect((await row(draft.id)).status).toBe("cancelled");
      expect((await listActivity(db, mine)).at(-1)).toMatchObject({ kind: "invoice_cancelled", detail: { invoiceId: null, voided: true } });
    });

    it("중복 번호인데 PayPal의 그 청구서가 결제할 수 있는 상태(SENT)이고 금액이 다르면 건드리지 않고 paypal_rejected이며 draft 그대로다", async () => {
      const draft = await orderOf(mine, "draft");
      const pp = realGateway(duplicateOf({ ...forDraft(sentInvoice, draft.id), amount: { currency_code: "USD", value: "600.00" } }));

      const result = await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_rejected" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: null, sendClaimedAt: null });
    });

    it("청구서 id가 있는 초안을 다시 보낼 때 PayPal이 발송을 거부하고 조회 상태가 CANCELLED면 cancelled로 표시하고 invoice_void다", async () => {
      const draft = await orderOf(mine, "draft");
      await db.update(changeOrders).set({ paypalInvoiceId: INVOICE_ID }).where(eq(changeOrders.id, draft.id));
      const paypal = fakeGateway({
        send: async () => Promise.reject(new PayPalError("rejected", 422, "CANNOT_SEND_INVOICE", null)),
        get: async (id) => ({ ...sentView(id, draft.id), status: "CANCELLED" }),
      });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "invoice_void" });
      expect(await row(draft.id)).toMatchObject({ status: "cancelled", sendClaimedAt: null });
      expect(paypal.calls.create).toHaveLength(0);
    });

    it("발송이 거부됐는데 조회 상태가 CANCELLED가 아니면(또는 조회도 실패하면) paypal_rejected이고 draft 그대로다", async () => {
      const draft = await orderOf(mine, "draft");
      const refuse = async () => Promise.reject(new PayPalError("rejected", 422, "CANNOT_SEND_INVOICE", null));
      const unpaid = fakeGateway({ send: refuse, get: async (id) => ({ ...sentView(id, draft.id), status: "UNPAID" }) });
      const unreadable = fakeGateway({ send: refuse, get: async () => Promise.reject(new PayPalError("unavailable", null, null, null)) });

      const results = [await sendOwnedChangeOrder(deps(unpaid.gateway), mine, draft.id), await sendOwnedChangeOrder(deps(unreadable.gateway), mine, draft.id)];

      expect(results).toEqual(Array(2).fill({ ok: false, error: "paypal_rejected" }));
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: INVOICE_ID, sendClaimedAt: null });
    });
  });

  describe("PayPal 발송 이후 단계의 실패 (P2-D2)", () => {
    // Makes one kind of write fail the way a busy or unreachable database does.
    const failWritesWhen = (condition: string) =>
      db.run(sql.raw(`CREATE TRIGGER fail_write BEFORE UPDATE ON change_orders WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'database is locked'); END`));
    const healWrites = () => db.run(sql`DROP TRIGGER fail_write`);

    it("PayPal이 발송한 뒤 sent 저장이 DB 오류로 실패하면 paypal_unconfirmed이고 발송 표시가 풀리며, 다시 발송하면 같은 청구서로 sent가 된다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway();
      await failWritesWhen("NEW.status = 'sent'");

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_unconfirmed" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: INVOICE_ID, sendClaimedAt: null });
      await healWrites();
      const again = fakeGateway({ send: async () => "already_sent", get: async (id) => sentView(id, draft.id) });
      expect(await sendOwnedChangeOrder(deps(again.gateway), mine, draft.id)).toEqual({ ok: true });
      expect([again.calls.create.length, again.calls.send]).toEqual([0, [INVOICE_ID]]);
      expect((await row(draft.id)).status).toBe("sent");
    });

    it("발송 전 청구서 id 저장이 DB 오류로 실패하면 PayPal 발송은 하지 않고 발송 표시를 푼 뒤 오류를 던진다(server_error)", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway();
      await failWritesWhen("NEW.paypal_invoice_id IS NOT NULL AND OLD.paypal_invoice_id IS NULL");

      await expect(sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id)).rejects.toThrow(/database is locked/);

      expect(paypal.calls.send).toHaveLength(0);
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: null, sendClaimedAt: null });
    });

    it("PayPal이 발송을 받은 뒤 조회가 실패하면 paypal_unavailable이 아니라 paypal_unconfirmed다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({ get: async () => Promise.reject(new PayPalError("unavailable", 503, "SERVICE_UNAVAILABLE", null)) });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_unconfirmed" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", paypalInvoiceId: INVOICE_ID, sendClaimedAt: null });
      expect((await listActivity(db, mine)).at(-1)?.detail).toMatchObject({ step: "read" });
    });

    it("PayPal이 발송을 받은 뒤 DRAFT로 보여 주면 sent로 저장하지 않고 paypal_unconfirmed다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({ get: async (id) => ({ ...sentView(id, draft.id), status: "DRAFT" }) });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      expect(result).toEqual({ ok: false, error: "paypal_unconfirmed" });
      expect(await row(draft.id)).toMatchObject({ status: "draft", sendClaimedAt: null, sentAt: null });
      expect((await listActivity(db, mine)).at(-1)?.summary).toBe("PayPal accepted the send but shows the invoice as DRAFT, so it isn't marked sent yet.");
    });

    it("PayPal 취소 뒤 cancelled 저장이 DB 오류로 실패하면 paypal_unconfirmed이고, 다시 취소하면 already_cancelled로 cancelled가 된다 (P2-D6)", async () => {
      const id = await sentOrder();
      await failWritesWhen("NEW.status = 'cancelled'");

      const result = await cancelOwnedChangeOrder(deps(fakeGateway().gateway), mine, id);

      expect(result).toEqual({ ok: false, error: "paypal_unconfirmed" });
      expect((await row(id)).status).toBe("sent");
      await healWrites();
      expect(await cancelOwnedChangeOrder(deps(fakeGateway({ cancel: async () => "already_cancelled" }).gateway), mine, id)).toEqual({ ok: true });
      expect((await row(id)).status).toBe("cancelled");
    });
  });

  describe("청구서가 생긴 초안의 무료 처리 (P2-D1)", () => {
    it("발송은 됐는데 조회가 실패한 초안은 무료 처리할 수 없고(invoice_exists) 다시 발송하면 같은 청구서로 sent가 된다", async () => {
      const draft = await orderOf(mine, "draft");
      const flaky = fakeGateway({ get: async () => Promise.reject(new PayPalError("unavailable", null, null, null)) });
      await sendOwnedChangeOrder(deps(flaky.gateway), mine, draft.id);
      expect(flaky.calls.send).toEqual([INVOICE_ID]); // PayPal has sent it; the client has the email

      const waived = await waiveOwnedChangeOrder(db, mine, draft.id, clock.now());
      const healthy = fakeGateway({ send: async () => "already_sent", get: async (id) => sentView(id, draft.id) });
      const resent = await sendOwnedChangeOrder(deps(healthy.gateway), mine, draft.id);

      expect(waived).toEqual({ ok: false, error: "invoice_exists" });
      expect(resent).toEqual({ ok: true });
      expect(healthy.calls.create).toHaveLength(0);
      expect(healthy.calls.send).toEqual([INVOICE_ID]);
      expect(await row(draft.id)).toMatchObject({ status: "sent", paypalInvoiceId: INVOICE_ID });
    });

    it("경합: PayPal 안에서 발송이 진행 중인 초안은 무료 처리가 in_progress로 막히고 발송이 끝나면 sent다", async () => {
      const draft = await orderOf(mine, "draft");
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const paypal = fakeGateway({
        send: async () => {
          await gate; // the invoice id is saved and PayPal is sending while the freelancer presses "include at no charge"
          return "sent";
        },
      });

      const sending = sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);
      await vi.waitFor(() => expect(paypal.calls.send).toHaveLength(1));
      const waived = await waiveOwnedChangeOrder(db, mine, draft.id, clock.now());
      openGate();

      expect(waived).toEqual({ ok: false, error: "in_progress" });
      expect(await sending).toEqual({ ok: true });
      expect((await row(draft.id)).status).toBe("sent");
    });
  });

  describe("취소", () => {
    it("발송된 견적을 취소하면 PayPal 취소 뒤 cancelled가 된다", async () => {
      const id = await sentOrder();
      const paypal = fakeGateway();

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, id);

      expect(result).toEqual({ ok: true });
      expect(paypal.calls.cancel).toEqual([INVOICE_ID]);
      expect((await row(id)).status).toBe("cancelled");
    });

    it("PayPal이 이미 취소됐다고 하면 cancelled로 맞추고 ok다", async () => {
      const id = await sentOrder();
      const paypal = fakeGateway({ cancel: async () => "already_cancelled" });

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, id);

      expect(result).toEqual({ ok: true });
      expect((await row(id)).status).toBe("cancelled");
      expect((await listActivity(db, mine)).at(-1)?.detail).toMatchObject({ alreadyCancelled: true });
    });

    it("PayPal이 이미 결제됐다고 하면 already_paid이고 상태는 sent 그대로다", async () => {
      const id = await sentOrder();
      const paypal = fakeGateway({ cancel: async () => "paid" });

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, id);

      expect(result).toEqual({ ok: false, error: "already_paid" });
      expect((await row(id)).status).toBe("sent");
      expect((await listActivity(db, mine)).at(-1)).toMatchObject({ kind: "paypal_failed", detail: { step: "cancel", issue: "CANNOT_CANCEL_PAID_INVOICE" } });
    });

    it("DB에서 paid인 견적은 invalid_state이고 PayPal을 부르지 않는다", async () => {
      const paid = await orderOf(mine, "paid");
      const paypal = fakeGateway();

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, paid.id);

      expect(result).toEqual({ ok: false, error: "invalid_state" });
      expect(paypal.total()).toBe(0);
    });

    it("draft·waived 견적은 취소할 수 없고 PayPal을 부르지 않는다", async () => {
      const draft = await orderOf(mine, "draft");
      const waived = await orderOf(theirs, "draft");
      await db.update(changeOrders).set({ status: "waived" }).where(eq(changeOrders.id, waived.id));
      const paypal = fakeGateway();

      const results = [await cancelOwnedChangeOrder(deps(paypal.gateway), mine, draft.id), await cancelOwnedChangeOrder(deps(paypal.gateway), theirs, waived.id)];

      expect(results).toEqual(Array(2).fill({ ok: false, error: "invalid_state" }));
      expect(paypal.total()).toBe(0);
    });

    it("다른 사본의 견적은 not_found이고 PayPal을 부르지 않는다", async () => {
      const id = await sentOrder();
      const paypal = fakeGateway();

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), theirs, id);

      expect(result).toEqual({ ok: false, error: "not_found" });
      expect(paypal.total()).toBe(0);
      expect((await row(id)).status).toBe("sent");
    });

    it("PayPal이 응답하지 않으면 paypal_unavailable이고 상태는 sent 그대로다", async () => {
      const id = await sentOrder();
      const paypal = fakeGateway({ cancel: async () => Promise.reject(new PayPalError("unavailable", 500, "INTERNAL_SERVER_ERROR", "d07c9a1e6b3f5")) });

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, id);

      expect(result).toEqual({ ok: false, error: "paypal_unavailable" });
      expect((await row(id)).status).toBe("sent");
    });

    it("처음 보는 이름의 422로 취소가 거부되면 paypal_rejected이고 상태는 sent 그대로다", async () => {
      const id = await sentOrder();
      const pp = realGateway({ [`POST /v2/invoicing/invoices/${INVOICE_ID}/cancel`]: { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INVOICE_LOCKED" }] } } });

      const result = await cancelOwnedChangeOrder(deps(pp.gateway), mine, id);

      expect(result).toEqual({ ok: false, error: "paypal_rejected" });
      expect((await row(id)).status).toBe("sent");
    });

    it("이미 cancelled인 견적은 PayPal을 부르지 않고 ok다", async () => {
      const id = await sentOrder();
      await cancelOwnedChangeOrder(deps(fakeGateway().gateway), mine, id);
      const paypal = fakeGateway();

      const result = await cancelOwnedChangeOrder(deps(paypal.gateway), mine, id);

      expect(result).toEqual({ ok: true });
      expect(paypal.total()).toBe(0);
    });

    it("PayPal 키가 없으면 취소도 not_configured다", async () => {
      const id = await sentOrder();

      expect(await cancelOwnedChangeOrder(deps(null), mine, id)).toEqual({ ok: false, error: "not_configured" });
      expect((await row(id)).status).toBe("sent");
    });
  });

  describe("다시 견적", () => {
    async function cancelledOrder(): Promise<string> {
      const id = await sentOrder();
      expect(await cancelOwnedChangeOrder(deps(fakeGateway().gateway), mine, id)).toEqual({ ok: true });
      return id;
    }
    const liveOrders = async (findingId: string) =>
      (await db.select().from(changeOrders).where(eq(changeOrders.findingId, findingId))).filter((o) => o.status !== "cancelled");

    it("취소된 견적을 다시 견적하면 같은 항목에 새 draft가 생기고 금액은 시급으로 다시 계산된다", async () => {
      const id = await cancelledOrder();
      const cancelled = await row(id);
      await db.update(projects).set({ hourlyRateCents: 6000 }).where(eq(projects.id, mine)); // $60/h since the first quote

      const result = await requoteOwnedChangeOrder(db, mine, id);

      const [fresh] = await liveOrders(cancelled.findingId);
      expect(result).toEqual({ ok: true });
      expect(fresh).toMatchObject({ status: "draft", title: cancelled.title, hours: 13, amountCents: 78000, extraDays: 3, paypalInvoiceId: null, sentAt: null });
      expect((await row(id)).status).toBe("cancelled");
    });

    it("다시 견적을 동시에 두 번 해도 draft는 하나다", async () => {
      const id = await cancelledOrder();

      const results = await Promise.all([requoteOwnedChangeOrder(db, mine, id), requoteOwnedChangeOrder(db, mine, id)]);

      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(await liveOrders((await row(id)).findingId)).toHaveLength(1);
    });

    it("cancelled가 아닌 견적은 다시 견적할 수 없다", async () => {
      const draft = await orderOf(mine, "draft");
      const paid = await orderOf(mine, "paid");

      const results = [await requoteOwnedChangeOrder(db, mine, draft.id), await requoteOwnedChangeOrder(db, mine, paid.id)];

      expect(results).toEqual(Array(2).fill({ ok: false, error: "invalid_state" }));
    });

    it("다른 사본의 취소된 견적은 not_found다", async () => {
      const id = await cancelledOrder();

      expect(await requoteOwnedChangeOrder(db, theirs, id)).toEqual({ ok: false, error: "not_found" });
    });

    it("다시 견적한 draft는 새 견적 id라 청구서 번호도 새로 나온다", async () => {
      const id = await cancelledOrder();

      await requoteOwnedChangeOrder(db, mine, id);

      const [fresh] = await liveOrders((await row(id)).findingId);
      expect(fresh.id).not.toBe(id);
      expect(invoiceNumberFor(fresh.id)).not.toBe(invoiceNumberFor(id));
    });

    it("다시 견적한 draft를 발송하면 새 번호로 청구서를 만든다", async () => {
      const id = await cancelledOrder();
      await requoteOwnedChangeOrder(db, mine, id);
      const [fresh] = await liveOrders((await row(id)).findingId);
      const paypal = fakeGateway({ create: async (input) => ({ id: "INV2-V26G-W6TK-FWP3-5XKU", invoiceNumber: invoiceNumberFor(input.changeOrderId), created: true }) });

      const result = await sendOwnedChangeOrder(deps(paypal.gateway), mine, fresh.id);

      expect(result).toEqual({ ok: true });
      expect(paypal.calls.create[0].changeOrderId).toBe(fresh.id);
      expect((await row(fresh.id)).paypalInvoiceId).toBe("INV2-V26G-W6TK-FWP3-5XKU");
    });
  });

  describe("활동 기록", () => {
    it("발송하면 invoice_created, invoice_sent가 그 순서로 남고 시각도 앞뒤가 맞다", async () => {
      const draft = await orderOf(mine, "draft");

      await sendOwnedChangeOrder(deps(fakeGateway().gateway), mine, draft.id);

      const events = await listActivity(db, mine);
      expect(events.map((e) => [e.kind, e.actor, e.changeOrderId])).toEqual([
        ["invoice_created", "paypal", draft.id],
        ["invoice_sent", "paypal", draft.id],
      ]);
      expect(events[0].at < events[1].at).toBe(true);
      expect(events[1].at).toBe((await row(draft.id)).sentAt);
      expect(events[0].summary).toBe(`Created PayPal invoice ${invoiceNumberFor(draft.id)} for $650 (draft)`);
      expect(events[1].summary).toBe(`Sent invoice ${invoiceNumberFor(draft.id)} to maya@harborandpine.example`);
      expect(events[0].detail).toEqual({ invoiceId: INVOICE_ID, invoiceNumber: invoiceNumberFor(draft.id), amount: "650.00", currency: "USD", reused: false });
      expect(events[1].detail).toEqual({ invoiceId: INVOICE_ID, paypalStatus: "SENT", payerViewUrl: PAYER_VIEW_URL, alreadySent: false });
    });

    it("취소하면 invoice_cancelled가 발송 기록 뒤에 남는다", async () => {
      const id = await sentOrder();

      await cancelOwnedChangeOrder(deps(fakeGateway().gateway), mine, id);

      const events = await listActivity(db, mine);
      expect(events.map((e) => e.kind)).toEqual(["invoice_created", "invoice_sent", "invoice_cancelled"]);
      expect(events[1].at < events[2].at).toBe(true);
      expect(events[2]).toMatchObject({ summary: `Cancelled invoice ${invoiceNumberFor(id)} in PayPal`, detail: { invoiceId: INVOICE_ID, alreadyCancelled: false } });
    });

    it("PayPal 실패는 paypal_failed로 남고 단계·HTTP 상태·issue·debug id만 담는다", async () => {
      const draft = await orderOf(mine, "draft");
      const paypal = fakeGateway({ send: async () => Promise.reject(new PayPalError("unavailable", 503, "SERVICE_UNAVAILABLE", "d07c9a1e6b3f5")) });

      await sendOwnedChangeOrder(deps(paypal.gateway), mine, draft.id);

      const failed = (await listActivity(db, mine)).at(-1);
      expect(failed).toMatchObject({ kind: "paypal_failed", actor: "paypal", changeOrderId: draft.id });
      expect(failed?.detail).toEqual({ step: "send", httpStatus: 503, issue: "SERVICE_UNAVAILABLE", debugId: "d07c9a1e6b3f5" });
      expect(failed?.summary).toBe("PayPal didn't respond while sending the invoice; trying again won't bill the client twice.");
    });

    it("활동 기록 어디에도 access token과 client secret 문자열이 없다", async () => {
      const draft = await orderOf(mine, "draft");
      const token = "A21AAstand-in-access-token-value";
      const pp = realGateway({
        "POST /v1/oauth2/token": { status: 200, body: tokenResponse(token) },
        "POST /v2/invoicing/invoices": [{ status: 401, body: invalidToken }, { status: 201, body: createdDraft }],
        [`POST /v2/invoicing/invoices/${INVOICE_ID}/send`]: [{ status: 500, body: { name: "INTERNAL_SERVER_ERROR", debug_id: "d07c9a1e6b3f5" } }, { status: 200, body: sendResponse }],
        [`GET /v2/invoicing/invoices/${INVOICE_ID}`]: { status: 200, body: { ...sentInvoice, detail: { ...sentInvoice.detail, reference: draft.id } } },
        [`POST /v2/invoicing/invoices/${INVOICE_ID}/cancel`]: { status: 204 },
      });

      await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id); // fails at send (500)
      await sendOwnedChangeOrder(deps(pp.gateway), mine, draft.id); // reuses the saved id and sends
      await cancelOwnedChangeOrder(deps(pp.gateway), mine, draft.id);

      const stored = JSON.stringify(await db.all(sql`SELECT * FROM activity_events`));
      expect(await kinds(mine)).toEqual(["invoice_created", "paypal_failed", "invoice_sent", "invoice_cancelled"]);
      expect(pp.to("POST /v1/oauth2/token").length).toBeGreaterThan(0);
      for (const secret of [token, "stand-in-client-secret-0123456789", Buffer.from("stand-in-client-id:stand-in-client-secret-0123456789").toString("base64")]) {
        expect(stored).not.toContain(secret);
      }
      expect(stored).not.toMatch(/Bearer|Basic|authorization/i);
    });

    it("다른 사본의 견적을 건드리려던 요청은 활동 기록을 남기지 않는다", async () => {
      const theirDraft = await orderOf(theirs, "draft");

      await sendOwnedChangeOrder(deps(fakeGateway().gateway), mine, theirDraft.id);

      expect(await db.select().from(activityEvents)).toEqual([]);
    });
  });
});
