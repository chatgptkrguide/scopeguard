import { describe, expect, it } from "vitest";
import { paymentDecision, paymentPrecheck, type InvoiceFacts, type PaymentOrder } from "./payment";

const ORDER_ID = "0244f9b8-b8ac-4e6b-b86d-f3d648c071e0";
const sent: PaymentOrder = { id: ORDER_ID, status: "sent", amountCents: 65000, paypalInvoiceId: "INV2-DZQM-QREH-7LAT-F7YR" };
const facts = (status: string, overrides: Partial<InvoiceFacts> = {}): InvoiceFacts => ({ status, reference: ORDER_ID, amountValue: "650.00", ...overrides });

describe("결제 정산 판단", () => {
  it("정산 판단: sent이고 PAID·reference·금액이 맞으면 settle(from sent)이다", () => {
    expect(paymentDecision(sent, facts("PAID"))).toEqual({ kind: "settle", from: "sent" });
  });

  it("정산 판단: 청구서 id가 있는 draft가 PAID면 settle(from draft)이다", () => {
    expect(paymentDecision({ ...sent, status: "draft" }, facts("PAID"))).toEqual({ kind: "settle", from: "draft" });
  });

  it("정산 판단: PARTIALLY_PAID와 PAYMENT_PENDING은 underWay인 not_settled다", () => {
    expect(paymentDecision(sent, facts("PARTIALLY_PAID"))).toEqual({ kind: "not_settled", underWay: true });
    expect(paymentDecision(sent, facts("PAYMENT_PENDING"))).toEqual({ kind: "not_settled", underWay: true });
  });

  it("정산 판단: SENT·UNPAID·CANCELLED·REFUNDED는 not_settled다", () => {
    for (const status of ["SENT", "UNPAID", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "SOMETHING_NEW"]) {
      expect(paymentDecision(sent, facts(status)), status).toEqual({ kind: "not_settled", underWay: false });
    }
  });

  it("정산 판단: reference가 다르거나 금액 문자열이 다르면 mismatch다", () => {
    expect(paymentDecision(sent, facts("PAID", { reference: "11111111-2222-4333-8444-555555555555" }))).toEqual({ kind: "mismatch" });
    expect(paymentDecision(sent, facts("PAID", { reference: null }))).toEqual({ kind: "mismatch" });
    expect(paymentDecision(sent, facts("PAID", { amountValue: "650" }))).toEqual({ kind: "mismatch" });
    expect(paymentDecision(sent, facts("PAID", { amountValue: "600.00" }))).toEqual({ kind: "mismatch" });
    expect(paymentDecision(sent, facts("PAID", { amountValue: null }))).toEqual({ kind: "mismatch" });
  });

  it("사전 판단: paid는 already_paid, waived·cancelled는 closed, 청구서 없는 draft는 no_invoice다", () => {
    expect(paymentPrecheck({ ...sent, status: "paid" })).toBe("already_paid");
    expect(paymentPrecheck({ ...sent, status: "waived" })).toBe("closed");
    expect(paymentPrecheck({ ...sent, status: "cancelled" })).toBe("closed");
    expect(paymentPrecheck({ ...sent, status: "draft", paypalInvoiceId: null })).toBe("no_invoice");
    expect(paymentPrecheck({ ...sent, status: "draft" })).toBe("read");
    expect(paymentPrecheck(sent)).toBe("read");
  });

  it("(PM 결정 D1) MARKED_AS_PAID는 settle이다", () => {
    expect(paymentDecision(sent, facts("MARKED_AS_PAID"))).toEqual({ kind: "settle", from: "sent" });
  });

  it("사전 판단이 read가 아닌 견적으로 정산을 판단하면 오류를 낸다", () => {
    expect(() => paymentDecision({ ...sent, status: "paid" }, facts("PAID"))).toThrow(RangeError);
    expect(() => paymentDecision({ ...sent, status: "draft", paypalInvoiceId: null }, facts("PAID"))).toThrow(RangeError);
  });
});
