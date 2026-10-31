import { describe, expect, it } from "vitest";
import { invoiceNumberFor } from "@/domain/invoice";
import { parseEnv } from "../env";
import { PayPalError } from "./errors";
import {
  CHANGE_ORDER_ID,
  INVOICE_ID,
  INVOICE_NUMBER,
  PAYER_VIEW_URL,
  cancelledInvoice,
  cannotCancelDraftInvoice,
  cannotCancelPaidInvoice,
  cannotSendInvoice,
  createdDraft,
  duplicateInvoiceNumber,
  fakeFetch,
  internalServerError,
  invalidRequest,
  invalidToken,
  invoiceAlreadySent,
  invoiceCanceledAlready,
  resourceNotFound,
  searchResult,
  sendResponse,
  sentInvoice,
  tokenResponse,
  totalAmountNegative,
  type FakeReply,
} from "../../../test/paypal-fixtures";
import {
  cancelInvoice,
  createInvoice,
  findByInvoiceNumber,
  getInvoice,
  invoiceBody,
  invoicesForReference,
  INVOICE_NUMBER_USED_UP,
  sendInvoice,
  type InvoiceInput,
} from "./invoices";
import { createPayPalClient, paypalConfig } from "./token";

const config = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "stand-in-id", PAYPAL_CLIENT_SECRET: "stand-in-secret" }))!;
const CREATE = "POST /v2/invoicing/invoices";
const SEARCH = "POST /v2/invoicing/search-invoices";
const SEND = `POST /v2/invoicing/invoices/${INVOICE_ID}/send`;
const CANCEL = `POST /v2/invoicing/invoices/${INVOICE_ID}/cancel`;
const GET = `GET /v2/invoicing/invoices/${INVOICE_ID}`;

const input: InvoiceInput = {
  changeOrderId: CHANGE_ORDER_ID,
  title: "Loyalty page with customer login",
  description: "Estimated 13 h at $50/h, rounded up to the next $10",
  note: "Change order for Online ordering site. Not part of the agreed scope.",
  amountCents: 65000,
  recipient: { email: "maya@harborandpine.example", businessName: "Harbor & Pine Coffee" },
};

function paypal(script: Readonly<Record<string, FakeReply | readonly FakeReply[]>>) {
  const fake = fakeFetch(script);
  return { ...fake, client: createPayPalClient(config, { fetch: fake.fetch }) };
}

async function failureOf(promise: Promise<unknown>): Promise<PayPalError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PayPalError);
  return error as PayPalError;
}

const json = (body: string | undefined): unknown => JSON.parse(body ?? "null");

describe("청구서 요청 본문", () => {
  it("청구서 본문은 USD, 항목 1개, 금액 문자열 \"650.00\"이고 invoicer가 없다", () => {
    const body = invoiceBody(input);

    expect(body.detail.currency_code).toBe("USD");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      name: "Loyalty page with customer login",
      description: "Estimated 13 h at $50/h, rounded up to the next $10",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "650.00" },
    });
    expect(body).not.toHaveProperty("invoicer");
    expect(body.detail.payment_term).toEqual({ term_type: "DUE_ON_RECEIPT" });
  });

  it("금액 65000센트는 \"650.00\", 249센트는 \"2.49\"로 보낸다", () => {
    expect(invoiceBody(input).items[0].unit_amount.value).toBe("650.00");
    expect(invoiceBody({ ...input, amountCents: 249 }).items[0].unit_amount.value).toBe("2.49");
    expect(invoiceBody({ ...input, amountCents: 249_000 }).items[0].unit_amount.value).toBe("2490.00");
  });

  it("reference는 견적 id, 청구서 번호는 invoiceNumberFor(견적 id), 수신인은 프로젝트 고객 이메일·이름이다", () => {
    const body = invoiceBody(input);

    expect(body.detail.reference).toBe(CHANGE_ORDER_ID);
    expect(body.detail.invoice_number).toBe(invoiceNumberFor(CHANGE_ORDER_ID));
    expect(body.detail.invoice_number).toBe(INVOICE_NUMBER);
    expect(body.primary_recipients).toEqual([{ billing_info: { business_name: "Harbor & Pine Coffee", email_address: "maya@harborandpine.example" } }]);
  });

  it("금액이 0 이하이거나 정수가 아니면 본문을 만들지 않는다", () => {
    expect(() => invoiceBody({ ...input, amountCents: 0 })).toThrow(RangeError);
    expect(() => invoiceBody({ ...input, amountCents: -500 })).toThrow(RangeError);
    expect(() => invoiceBody({ ...input, amountCents: 650.5 })).toThrow(RangeError);
  });

  it("항목 이름은 200자, 메모는 4000자로 자른다", () => {
    const body = invoiceBody({ ...input, title: "x".repeat(250), note: "y".repeat(5000) });

    expect(body.items[0].name).toHaveLength(200);
    expect(body.detail.note).toHaveLength(4000);
  });
});

describe("청구서 작성", () => {
  it("작성 요청에 Prefer: return=representation과 PayPal-Request-Id(견적 id)를 보낸다", async () => {
    const pp = paypal({ [CREATE]: { status: 201, body: createdDraft } });

    await createInvoice(pp.client, input);

    const [call] = pp.to(CREATE);
    expect(call.headers.prefer).toBe("return=representation");
    expect(call.headers["paypal-request-id"]).toBe(CHANGE_ORDER_ID);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(json(call.body)).toEqual(invoiceBody(input));
  });

  it("작성 201이면 청구서 id를 돌려주고 created가 true다", async () => {
    const pp = paypal({ [CREATE]: { status: 201, body: createdDraft } });

    const created = await createInvoice(pp.client, input);

    expect(created).toEqual({ id: INVOICE_ID, invoiceNumber: INVOICE_NUMBER, created: true });
  });

  it("작성 201에 본문 대신 self 링크만 와도 그 링크에서 청구서 id를 읽는다", async () => {
    const pp = paypal({
      [CREATE]: { status: 201, body: { rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${INVOICE_ID}`, method: "GET", links: [{ rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${INVOICE_ID}`, method: "GET" }] } },
    });

    const created = await createInvoice(pp.client, input);

    expect(created.id).toBe(INVOICE_ID);
  });

  it("작성이 422 DUPLICATE_INVOICE_NUMBER면 번호로 찾아 같은 견적의 청구서 id를 돌려주고 created가 false다", async () => {
    const pp = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(createdDraft) } });

    const created = await createInvoice(pp.client, input);

    expect(created).toEqual({ id: INVOICE_ID, invoiceNumber: INVOICE_NUMBER, created: false });
    expect(json(pp.to(SEARCH)[0].body)).toEqual({ invoice_number: INVOICE_NUMBER });
    expect(pp.to(CREATE)).toHaveLength(1);
  });

  it("번호로 찾은 청구서가 결제할 수 있는 상태(SENT)인데 reference나 금액이 다르면 그대로 두고 rejected 오류를 낸다", async () => {
    const otherReference = { ...sentInvoice, detail: { ...sentInvoice.detail, reference: "11111111-1111-4111-8111-111111111111" } };
    const otherAmount = { ...sentInvoice, amount: { currency_code: "USD", value: "600.00" } };
    const byReference = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(otherReference) } });
    const byAmount = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(otherAmount) } });

    const errors = [await failureOf(createInvoice(byReference.client, input)), await failureOf(createInvoice(byAmount.client, input))];

    expect(errors.map((e) => [e.failure, e.httpStatus, e.issue])).toEqual([
      ["rejected", 422, "DUPLICATE_INVOICE_NUMBER"],
      ["rejected", 422, "DUPLICATE_INVOICE_NUMBER"],
    ]);
  });

  it("번호로 찾은 청구서가 DRAFT인데 reference나 금액이 다르면 번호를 다 쓴 것으로 보고 INVOICE_NUMBER_USED_UP(rejected)을 낸다", async () => {
    const otherReference = { ...createdDraft, detail: { ...createdDraft.detail, reference: "11111111-1111-4111-8111-111111111111" } };
    const otherAmount = { ...createdDraft, amount: { currency_code: "USD", value: "600.00" } };
    const byReference = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(otherReference) } });
    const byAmount = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(otherAmount) } });

    const errors = [await failureOf(createInvoice(byReference.client, input)), await failureOf(createInvoice(byAmount.client, input))];

    expect(errors.map((e) => [e.failure, e.httpStatus, e.issue])).toEqual([
      ["rejected", 422, INVOICE_NUMBER_USED_UP],
      ["rejected", 422, INVOICE_NUMBER_USED_UP],
    ]);
  });

  it("번호로 찾은 청구서가 CANCELLED면(같은 견적이어도) 다시 쓰지 않고 INVOICE_NUMBER_USED_UP(rejected)을 낸다", async () => {
    const pp = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult(cancelledInvoice) } });

    const error = await failureOf(createInvoice(pp.client, input));

    expect([error.failure, error.issue]).toEqual(["rejected", INVOICE_NUMBER_USED_UP]);
    expect(pp.to(CREATE)).toHaveLength(1);
  });

  it("번호 검색이 0건이면 unavailable 오류를 낸다", async () => {
    const pp = paypal({ [CREATE]: { status: 422, body: duplicateInvoiceNumber }, [SEARCH]: { status: 200, body: searchResult() } });

    const error = await failureOf(createInvoice(pp.client, input));

    expect([error.failure, error.issue]).toEqual(["unavailable", "DUPLICATE_INVOICE_NUMBER"]);
  });
});

describe("청구서 발송·조회·취소", () => {
  it("발송 200이면 sent, 422 INVOICE_ALREADY_SENT면 already_sent다", async () => {
    const pp = paypal({ [SEND]: [{ status: 200, body: sendResponse }, { status: 422, body: invoiceAlreadySent }] });

    const results = [await sendInvoice(pp.client, INVOICE_ID), await sendInvoice(pp.client, INVOICE_ID)];

    expect(results).toEqual(["sent", "already_sent"]);
    expect(json(pp.to(SEND)[0].body)).toEqual({ send_to_recipient: true, send_to_invoicer: false });
  });

  it("발송 202(예약)는 rejected 오류다", async () => {
    const pp = paypal({ [SEND]: { status: 202, body: sendResponse } });

    const error = await failureOf(sendInvoice(pp.client, INVOICE_ID));

    expect([error.failure, error.httpStatus, error.issue]).toEqual(["rejected", 202, "SCHEDULED"]);
  });

  it("발송 422 CANNOT_SEND_INVOICE는 rejected 오류이고 issue가 담긴다", async () => {
    const pp = paypal({ [SEND]: { status: 422, body: cannotSendInvoice } });

    const error = await failureOf(sendInvoice(pp.client, INVOICE_ID));

    expect([error.failure, error.httpStatus, error.issue, error.debugId]).toEqual(["rejected", 422, "CANNOT_SEND_INVOICE", "f5a1c27e3b9d4"]);
  });

  it("조회는 status와 recipient_view_url을 읽는다", async () => {
    const pp = paypal({ [GET]: { status: 200, body: sentInvoice } });

    const view = await getInvoice(pp.client, INVOICE_ID);

    expect(view).toEqual({
      id: INVOICE_ID,
      status: "SENT",
      invoiceNumber: INVOICE_NUMBER,
      reference: CHANGE_ORDER_ID,
      amountValue: "650.00",
      currencyCode: "USD",
      payerViewUrl: PAYER_VIEW_URL,
    });
  });

  it("조회한 결제 링크가 샌드박스 결제 화면이 아니면 null로 돌려준다", async () => {
    const odd = { ...sentInvoice, detail: { ...sentInvoice.detail, metadata: { ...sentInvoice.detail.metadata, recipient_view_url: "javascript:alert(1)" } } };
    const pp = paypal({ [GET]: { status: 200, body: odd } });

    const view = await getInvoice(pp.client, INVOICE_ID);

    expect(view.payerViewUrl).toBeNull();
  });

  it("취소 204는 cancelled, 422 INVOICE_CANCELED_ALREADY는 already_cancelled, 422 CANNOT_CANCEL_PAID_INVOICE는 paid다", async () => {
    const pp = paypal({ [CANCEL]: [{ status: 204 }, { status: 422, body: invoiceCanceledAlready }, { status: 422, body: cannotCancelPaidInvoice }] });

    const results = [await cancelInvoice(pp.client, INVOICE_ID), await cancelInvoice(pp.client, INVOICE_ID), await cancelInvoice(pp.client, INVOICE_ID)];

    expect(results).toEqual(["cancelled", "already_cancelled", "paid"]);
    expect(json(pp.to(CANCEL)[0].body)).toEqual({ send_to_recipient: true, send_to_invoicer: false });
  });

  it("초안 취소 422 CANNOT_CANCEL_DRAFT_INVOICE는 rejected 오류다", async () => {
    const pp = paypal({ [CANCEL]: { status: 422, body: cannotCancelDraftInvoice } });

    const error = await failureOf(cancelInvoice(pp.client, INVOICE_ID));

    expect([error.failure, error.issue]).toEqual(["rejected", "CANNOT_CANCEL_DRAFT_INVOICE"]);
  });

  it("청구서 id가 PayPal 모양이 아니면 PayPal을 부르지 않고 rejected 오류를 낸다", async () => {
    const pp = paypal({});

    const errors = [
      await failureOf(sendInvoice(pp.client, "../oauth2/token")),
      await failureOf(getInvoice(pp.client, "INV2-DZQM")),
      await failureOf(cancelInvoice(pp.client, "")),
    ];

    expect(errors.map((e) => e.failure)).toEqual(["rejected", "rejected", "rejected"]);
    expect(pp.calls).toHaveLength(0);
  });
});

describe("오류 4종", () => {
  it("오류 4종 — 401 토큰 만료: 새 토큰으로 다시 보내 성공한다", async () => {
    const pp = paypal({
      "POST /v1/oauth2/token": [{ status: 200, body: tokenResponse("A21A-expired") }, { status: 200, body: tokenResponse("A21A-renewed") }],
      [CREATE]: [{ status: 401, body: invalidToken }, { status: 201, body: createdDraft }],
      [SEND]: { status: 200, body: sendResponse },
    });

    const created = await createInvoice(pp.client, input);
    const sent = await sendInvoice(pp.client, created.id);

    expect([created.id, sent]).toEqual([INVOICE_ID, "sent"]);
    expect(pp.to(CREATE).map((c) => c.headers.authorization)).toEqual(["Bearer A21A-expired", "Bearer A21A-renewed"]);
    expect(pp.to(SEND)[0].headers.authorization).toBe("Bearer A21A-renewed");
  });

  it("오류 4종 — 422 검증 오류: rejected이고 issue·debug id가 담긴다", async () => {
    const pp = paypal({ [SEND]: { status: 422, body: cannotSendInvoice }, [CANCEL]: { status: 422, body: cannotCancelDraftInvoice } });

    const errors = [await failureOf(sendInvoice(pp.client, INVOICE_ID)), await failureOf(cancelInvoice(pp.client, INVOICE_ID))];

    expect(errors.map((e) => [e.failure, e.httpStatus, e.issue, e.debugId])).toEqual([
      ["rejected", 422, "CANNOT_SEND_INVOICE", "f5a1c27e3b9d4"],
      ["rejected", 422, "CANNOT_CANCEL_DRAFT_INVOICE", "f5a1c27e3b9d4"],
    ]);
  });

  it("오류 4종 — 5xx와 네트워크 오류: unavailable이다", async () => {
    const server = paypal({ [CREATE]: { status: 500, body: internalServerError }, [GET]: { status: 503, body: "" } });
    const network = paypal({ [SEND]: "network-error", [CANCEL]: "network-error" });

    const errors = [
      await failureOf(createInvoice(server.client, input)),
      await failureOf(getInvoice(server.client, INVOICE_ID)),
      await failureOf(sendInvoice(network.client, INVOICE_ID)),
      await failureOf(cancelInvoice(network.client, INVOICE_ID)),
    ];

    expect(errors.map((e) => [e.failure, e.httpStatus])).toEqual([
      ["unavailable", 500],
      ["unavailable", 503],
      ["unavailable", null],
      ["unavailable", null],
    ]);
    expect(errors[0].debugId).toBe("d07c9a1e6b3f5");
    expect(server.to(CREATE)).toHaveLength(1); // 5xx is not retried; the invoice number makes a later retry safe
  });

  it("오류 4종 — 이미 발송·이미 취소: 오류 없이 already_sent·already_cancelled를 돌려준다", async () => {
    const pp = paypal({ [SEND]: { status: 422, body: invoiceAlreadySent }, [CANCEL]: { status: 422, body: invoiceCanceledAlready } });

    const results = [await sendInvoice(pp.client, INVOICE_ID), await cancelInvoice(pp.client, INVOICE_ID)];

    expect(results).toEqual(["already_sent", "already_cancelled"]);
  });

  it("400 INVALID_REQUEST와 406 TOTAL_AMOUNT_NEGATIVE는 rejected다", async () => {
    const pp = paypal({ [CREATE]: { status: 400, body: invalidRequest }, [SEND]: { status: 406, body: totalAmountNegative } });

    const errors = [await failureOf(createInvoice(pp.client, input)), await failureOf(sendInvoice(pp.client, INVOICE_ID))];

    expect(errors.map((e) => [e.failure, e.httpStatus, e.issue])).toEqual([
      ["rejected", 400, "INVALID_PARAMETER_SYNTAX"],
      ["rejected", 406, "TOTAL_AMOUNT_NEGATIVE"],
    ]);
  });

  it("404는 not_found다", async () => {
    const pp = paypal({ [GET]: { status: 404, body: resourceNotFound }, [SEND]: { status: 404, body: resourceNotFound }, [CANCEL]: { status: 404, body: resourceNotFound } });

    const errors = [
      await failureOf(getInvoice(pp.client, INVOICE_ID)),
      await failureOf(sendInvoice(pp.client, INVOICE_ID)),
      await failureOf(cancelInvoice(pp.client, INVOICE_ID)),
    ];

    expect(errors.map((e) => [e.failure, e.issue])).toEqual([
      ["not_found", "RESOURCE_NOT_FOUND"],
      ["not_found", "RESOURCE_NOT_FOUND"],
      ["not_found", "RESOURCE_NOT_FOUND"],
    ]);
  });
});

// The 422 issue names are not in PayPal's published schema (seen only in the sandbox), so a name PayPal
// might rename, or a 422 without any name, must land on the safe side: refused, nothing reused or re-sent.
describe("처음 보는 422", () => {
  const unknown422 = { status: 422, body: { name: "UNPROCESSABLE_ENTITY", debug_id: "e0e0e0e0e0e0e", details: [{ issue: "INVOICE_NUMBER_ALREADY_USED" }] } };
  const nameless422 = { status: 422, body: { message: "Unprocessable" } };
  const emptyBody422 = { status: 422, body: "" };

  it("작성이 처음 보는 이름이나 이름 없는 422를 받으면 rejected이고 번호 검색도 다시 작성도 하지 않는다", async () => {
    const pp = paypal({ [CREATE]: [unknown422, nameless422, emptyBody422], [SEARCH]: { status: 200, body: searchResult(createdDraft) } });

    const errors = [
      await failureOf(createInvoice(pp.client, input)),
      await failureOf(createInvoice(pp.client, input)),
      await failureOf(createInvoice(pp.client, input)),
    ];

    expect(errors.map((e) => [e.failure, e.httpStatus, e.issue])).toEqual([
      ["rejected", 422, "INVOICE_NUMBER_ALREADY_USED"],
      ["rejected", 422, null],
      ["rejected", 422, null],
    ]);
    expect(pp.to(SEARCH)).toHaveLength(0);
    expect(pp.to(CREATE)).toHaveLength(3); // one call per attempt, no automatic retry
  });

  it("발송이 처음 보는 이름이나 이름 없는 422를 받으면 already_sent로 보지 않고 rejected다", async () => {
    const pp = paypal({ [SEND]: [unknown422, nameless422, emptyBody422] });

    const errors = [
      await failureOf(sendInvoice(pp.client, INVOICE_ID)),
      await failureOf(sendInvoice(pp.client, INVOICE_ID)),
      await failureOf(sendInvoice(pp.client, INVOICE_ID)),
    ];

    expect(errors.map((e) => e.failure)).toEqual(["rejected", "rejected", "rejected"]);
  });

  it("취소가 처음 보는 이름이나 이름 없는 422를 받으면 cancelled·paid로 보지 않고 rejected다", async () => {
    const pp = paypal({ [CANCEL]: [unknown422, nameless422, emptyBody422] });

    const errors = [
      await failureOf(cancelInvoice(pp.client, INVOICE_ID)),
      await failureOf(cancelInvoice(pp.client, INVOICE_ID)),
      await failureOf(cancelInvoice(pp.client, INVOICE_ID)),
    ];

    expect(errors.map((e) => e.failure)).toEqual(["rejected", "rejected", "rejected"]);
  });
});

describe("청구서 검색", () => {
  it("번호 검색은 정확히 그 번호인 청구서만 돌려주고, 없으면 null이다", async () => {
    const other = { ...createdDraft, id: "INV2-AAAA-BBBB-CCCC-DDDD", detail: { ...createdDraft.detail, invoice_number: "TG-OTHER" } };
    const pp = paypal({ [SEARCH]: [{ status: 200, body: searchResult(other, createdDraft) }, { status: 200, body: searchResult(other) }] });

    const found = await findByInvoiceNumber(pp.client, INVOICE_NUMBER);
    const missing = await findByInvoiceNumber(pp.client, INVOICE_NUMBER);

    expect(found?.id).toBe(INVOICE_ID);
    expect(missing).toBeNull();
  });

  it("reference 검색은 부분 일치 결과에서 reference가 정확히 같은 것만 남긴다", async () => {
    const prefixOnly = { ...createdDraft, id: "INV2-F23U-BL74-HE72-B87S", detail: { ...createdDraft.detail, reference: `${CHANGE_ORDER_ID}-x` } };
    const pp = paypal({ [SEARCH]: { status: 200, body: searchResult(prefixOnly, createdDraft) } });

    const found = await invoicesForReference(pp.client, CHANGE_ORDER_ID);

    expect(found.map((i) => i.id)).toEqual([INVOICE_ID]);
    expect(json(pp.to(SEARCH)[0].body)).toEqual({ reference: CHANGE_ORDER_ID });
  });
});
