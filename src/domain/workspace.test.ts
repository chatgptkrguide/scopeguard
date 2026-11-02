import { describe, expect, it } from "vitest";
import type { ChangeOrder, ChangeOrderStatus } from "./types";
import { displayedOrder, projectTotals } from "./workspace";

const scope = [{ amountCents: 90000 }, { amountCents: 120000 }, { amountCents: 30000 }];

function order(id: string, status: ChangeOrderStatus, amountCents: number, sentAt: string | null = null): ChangeOrder {
  return {
    id,
    projectId: "p",
    findingId: "f",
    title: id,
    hours: 1,
    amountCents,
    extraDays: 1,
    status,
    paypalInvoiceId: sentAt ? `INV-${id}` : null,
    payerViewUrl: null,
    sentAt,
    paidAt: status === "paid" ? sentAt : null,
  };
}

describe("작업 화면 합계", () => {
  it("합계: 합의 $2,400, 변경 포함 $3,300, 결제됨 $250 (시드 숫자)", () => {
    const totals = projectTotals(scope, [order("gift", "paid", 25000, "2026-10-24T16:00:00Z"), order("loyalty", "draft", 65000)]);

    expect(totals).toEqual({
      agreedCents: 240000,
      changeOrdersCents: 90000,
      totalCents: 330000,
      paidCents: 25000,
      hasUnpaid: true,
    });
  });

  it("무료 처리한 견적은 변경 포함 합계에서 빠진다", () => {
    const totals = projectTotals(scope, [order("gift", "paid", 25000, "2026-10-24T16:00:00Z"), order("loyalty", "waived", 65000)]);

    expect(totals.changeOrdersCents).toBe(25000);
    expect(totals.totalCents).toBe(265000);
  });

  it("취소된 견적은 합계에서 빠진다", () => {
    const totals = projectTotals(scope, [order("old", "cancelled", 65000, "2026-11-02T10:00:00Z"), order("new", "sent", 70000, "2026-11-03T10:00:00Z")]);

    expect(totals.changeOrdersCents).toBe(70000);
    expect(totals.paidCents).toBe(0);
  });

  it("초안이나 발송된 견적이 있으면 미결제로 본다", () => {
    expect(projectTotals(scope, [order("a", "draft", 100)]).hasUnpaid).toBe(true);
    expect(projectTotals(scope, [order("a", "sent", 100, "2026-11-02T10:00:00Z")]).hasUnpaid).toBe(true);
    expect(projectTotals(scope, [order("a", "paid", 100, "2026-11-02T10:00:00Z"), order("b", "waived", 100)]).hasUnpaid).toBe(false);
  });

  it("견적이 없으면 변경 합계는 0이고 미결제도 없다", () => {
    expect(projectTotals([], [])).toEqual({ agreedCents: 0, changeOrdersCents: 0, totalCents: 0, paidCents: 0, hasUnpaid: false });
  });
});

describe("항목에 보여 줄 견적 고르기", () => {
  it("같은 항목에 취소 견적과 살아 있는 견적이 있으면 살아 있는 쪽을 보여 준다", () => {
    const cancelled = order("old", "cancelled", 65000, "2026-11-02T10:00:00Z");
    const live = order("new", "draft", 65000);

    expect(displayedOrder([cancelled, live])).toBe(live);
    expect(displayedOrder([live, cancelled])).toBe(live);
  });

  it("취소 견적만 있으면 가장 늦게 보낸 것을 보여 주고, 견적이 없으면 null이다", () => {
    const first = order("first", "cancelled", 65000, "2026-11-02T10:00:00Z");
    const second = order("second", "cancelled", 65000, "2026-11-03T10:00:00Z");

    expect(displayedOrder([second, first])).toBe(second);
    expect(displayedOrder([first, second])).toBe(second);
    expect(displayedOrder([])).toBeNull();
  });

  it("보낸 시각이 같거나 둘 다 보낸 적이 없는 취소 견적이면 목록에서 나중 것(나중에 만든 것)을 보여 준다", () => {
    const older = order("ffff", "cancelled", 65000);
    const newer = order("0000", "cancelled", 65000);
    const sentOlder = order("ffff-sent", "cancelled", 65000, "2026-11-02T10:00:00Z");
    const sentNewer = order("0000-sent", "cancelled", 65000, "2026-11-02T10:00:00Z");

    expect(displayedOrder([older, newer])).toBe(newer);
    expect(displayedOrder([sentOlder, sentNewer])).toBe(sentNewer);
  });
});
