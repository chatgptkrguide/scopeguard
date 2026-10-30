import { describe, expect, it } from "vitest";
import { extraDaysForHours, formatUsd, priceForHours, sumCents, toPayPalValue } from "./money";

describe("priceForHours", () => {
  it("시간 × 단가를 계산하고 다음 10달러 단위로 올린다", () => {
    expect(priceForHours(13, 5000)).toBe(65000); // 13h × $50 = $650
    expect(priceForHours(1.5, 4500)).toBe(7000); // $67.50 → $70
  });

  it("값이 없거나 잘못되면 0을 돌려준다", () => {
    expect(priceForHours(0, 5000)).toBe(0);
    expect(priceForHours(-2, 5000)).toBe(0);
    expect(priceForHours(Number.NaN, 5000)).toBe(0);
    expect(priceForHours(3, 0)).toBe(0);
  });
});

describe("extraDaysForHours", () => {
  it("하루가 안 되는 시간은 하루로 올린다", () => {
    expect(extraDaysForHours(13, 6)).toBe(3);
    expect(extraDaysForHours(12, 6)).toBe(2);
    expect(extraDaysForHours(0, 6)).toBe(0);
  });
});

describe("금액 표기", () => {
  it("화면용 금액은 달러 정수로 표기한다", () => {
    expect(formatUsd(240000)).toBe("$2,400");
  });

  it("PayPal 금액은 소수 둘째 자리 문자열로 만들고 잘못된 값은 거부한다", () => {
    expect(toPayPalValue(65000)).toBe("650.00");
    expect(toPayPalValue(1999)).toBe("19.99");
    expect(() => toPayPalValue(-1)).toThrow(RangeError);
    expect(() => toPayPalValue(10.5)).toThrow(RangeError);
  });

  it("센트 합계를 구한다", () => {
    expect(sumCents([90000, 120000, 30000])).toBe(240000);
    expect(sumCents([])).toBe(0);
  });
});
