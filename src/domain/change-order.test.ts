import { describe, expect, it } from "vitest";
import { canTransition, isBillable, transition, TransitionError } from "./change-order";
import type { ChangeOrder } from "./types";

const draft: ChangeOrder = {
  id: "co1",
  projectId: "p1",
  findingId: "f1",
  title: "Loyalty page with customer login",
  hours: 13,
  amountCents: 65000,
  extraDays: 3,
  status: "draft",
  paypalInvoiceId: null,
  payerViewUrl: null,
  sentAt: null,
  paidAt: null,
};

describe("추가 견적 상태 변화", () => {
  it("초안 → 발송 → 결제 순서로 바뀐다", () => {
    const sent = transition(draft, "sent", { at: "2026-11-02T10:00:00Z", paypalInvoiceId: "INV2-AAAA", payerViewUrl: "https://example.test/inv" });
    expect(sent).toMatchObject({ status: "sent", paypalInvoiceId: "INV2-AAAA", sentAt: "2026-11-02T10:00:00Z" });
    const paid = transition(sent, "paid", { at: "2026-11-03T09:00:00Z" });
    expect(paid).toMatchObject({ status: "paid", paidAt: "2026-11-03T09:00:00Z", paypalInvoiceId: "INV2-AAAA" });
  });

  it("PayPal 청구서 번호 없이는 발송 상태가 될 수 없다", () => {
    expect(() => transition(draft, "sent")).toThrow(/invoice id/);
  });

  it("초안은 무료 처리, 발송된 건은 취소할 수 있다", () => {
    expect(transition(draft, "waived").status).toBe("waived");
    const sent = transition(draft, "sent", { paypalInvoiceId: "INV2-AAAA" });
    expect(transition(sent, "cancelled").status).toBe("cancelled");
  });

  it("그 밖의 변화와 같은 상태 반복은 거부한다", () => {
    expect(canTransition("draft", "paid")).toBe(false);
    expect(canTransition("paid", "paid")).toBe(false);
    expect(canTransition("waived", "sent")).toBe(false);
    expect(() => transition(draft, "paid")).toThrow(TransitionError);
  });

  it("원래 객체를 바꾸지 않는다", () => {
    transition(draft, "waived");
    expect(draft.status).toBe("draft");
  });
});

describe("isBillable", () => {
  it("진행 중·결제된 건만 합계에 넣는다", () => {
    expect(["draft", "sent", "paid"].every((status) => isBillable({ status: status as ChangeOrder["status"] }))).toBe(true);
    expect(isBillable({ status: "waived" })).toBe(false);
    expect(isBillable({ status: "cancelled" })).toBe(false);
  });
});
