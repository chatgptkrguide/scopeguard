import { describe, expect, it } from "vitest";
import { canTransition, isBillable, isUnpaid } from "./change-order";
import { CHANGE_ORDER_STATUSES, type ChangeOrderStatus } from "./types";

// Every pair of statuses, so a move added or removed by mistake fails here.
const ALLOWED: readonly (readonly [ChangeOrderStatus, ChangeOrderStatus])[] = [
  ["draft", "sent"],
  ["draft", "waived"],
  ["draft", "cancelled"], // only when PayPal already shows the invoice as cancelled (P2-D4)
  ["sent", "paid"],
  ["sent", "cancelled"],
];

describe("추가 견적 상태 변화", () => {
  it("허용된 다섯 가지 변화만 true다", () => {
    const allowed = CHANGE_ORDER_STATUSES.flatMap((from) => CHANGE_ORDER_STATUSES.filter((to) => canTransition(from, to)).map((to) => [from, to]));

    expect(allowed).toEqual(ALLOWED);
  });

  it("같은 상태 반복과 결제·무료 처리·취소 뒤의 변화는 거부한다", () => {
    for (const status of CHANGE_ORDER_STATUSES) expect(canTransition(status, status), status).toBe(false);
    for (const to of CHANGE_ORDER_STATUSES) {
      expect(canTransition("paid", to)).toBe(false);
      expect(canTransition("waived", to)).toBe(false);
      expect(canTransition("cancelled", to)).toBe(false);
    }
    expect(canTransition("draft", "paid")).toBe(false);
  });
});

describe("isBillable · isUnpaid", () => {
  it("진행 중·결제된 건만 합계에 넣고, 그중 결제 전인 건은 초안과 발송된 건이다", () => {
    const billable = CHANGE_ORDER_STATUSES.filter((status) => isBillable({ status }));
    const unpaid = CHANGE_ORDER_STATUSES.filter((status) => isUnpaid({ status }));

    expect(billable).toEqual(["draft", "sent", "paid"]);
    expect(unpaid).toEqual(["draft", "sent"]);
  });
});
