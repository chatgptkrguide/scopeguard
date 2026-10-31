import { describe, expect, it } from "vitest";
import { invoiceNumberFor, safePayerViewUrl, SENT_LIKE } from "./invoice";

describe("청구서 번호", () => {
  it("청구서 번호는 25자이고 TG-로 시작하며 대문자와 숫자만 쓴다", () => {
    const number = invoiceNumberFor(crypto.randomUUID());

    expect(number).toHaveLength(25);
    expect(number).toMatch(/^TG-[0-9A-Z]{22}$/);
  });

  it("같은 견적 id는 늘 같은 청구서 번호가 된다(대소문자도 가리지 않는다)", () => {
    const id = crypto.randomUUID();

    expect(invoiceNumberFor(id)).toBe(invoiceNumberFor(id));
    expect(invoiceNumberFor(id.toUpperCase())).toBe(invoiceNumberFor(id));
  });

  it("다른 견적 id 1만 개는 서로 다른 청구서 번호가 된다", () => {
    const numbers = new Set(Array.from({ length: 10_000 }, () => invoiceNumberFor(crypto.randomUUID())));

    expect(numbers.size).toBe(10_000);
  });

  it("샌드박스에서 쓴 견적 id는 실제로 PayPal이 받은 번호와 같다(0244f9b8-… → TG-4ILUBN7LCCN6SKDSN5C15S)", () => {
    expect(invoiceNumberFor("0244f9b8-b8ac-4e6b-b86d-f3d648c071e0")).toBe("TG-4ILUBN7LCCN6SKDSN5C15S");
  });

  it("가장 작은 id와 가장 큰 id도 25자 번호가 된다", () => {
    expect(invoiceNumberFor("00000000-0000-0000-0000-000000000000")).toBe(`TG-${"0".repeat(22)}`);
    expect(invoiceNumberFor("ffffffff-ffff-ffff-ffff-ffffffffffff")).toHaveLength(25);
  });

  it("UUID가 아닌 id는 번호를 만들지 않고 오류를 낸다", () => {
    expect(() => invoiceNumberFor("demo-co2")).toThrow(RangeError);
    expect(() => invoiceNumberFor("")).toThrow(RangeError);
  });
});

describe("결제 링크 검사", () => {
  it("샌드박스 결제 화면 링크는 그대로 받는다", () => {
    const url = "https://www.sandbox.paypal.com/invoice/p/#DZQMQREH7LATF7YR";

    expect(safePayerViewUrl(url, "sandbox")).toBe(url);
    expect(safePayerViewUrl("https://www.sandbox.paypal.com/invoice/p/#INV2-3XAZ-YS6T-5QRP-FPYQ", "sandbox")).not.toBeNull();
  });

  it("sandbox.paypal.com/invoice/p/로 시작하지 않는 결제 링크는 null이 된다(http:, javascript:, 다른 호스트)", () => {
    const refused = [
      "http://www.sandbox.paypal.com/invoice/p/#DZQMQREH7LATF7YR",
      "javascript:alert(1)//https://www.sandbox.paypal.com/invoice/p/",
      "https://www.sandbox.paypal.com.evil.example/invoice/p/#X",
      "https://evil.example/https://www.sandbox.paypal.com/invoice/p/",
      "https://www.sandbox.paypal.com/invoice/details/INV2-DZQM-QREH-7LAT-F7YR",
      'https://www.sandbox.paypal.com/invoice/p/#X" onmouseover="x',
      "https://www.sandbox.paypal.com/invoice/p/#X\nY",
      `https://www.sandbox.paypal.com/invoice/p/#${"A".repeat(3000)}`,
    ];

    expect(refused.map((url) => safePayerViewUrl(url, "sandbox"))).toEqual(refused.map(() => null));
  });

  it("문자열이 아니거나 live 환경이면 null이다", () => {
    expect(safePayerViewUrl(undefined, "sandbox")).toBeNull();
    expect(safePayerViewUrl({ href: "https://www.sandbox.paypal.com/invoice/p/#X" }, "sandbox")).toBeNull();
    expect(safePayerViewUrl("https://www.sandbox.paypal.com/invoice/p/#X", "live")).toBeNull();
  });
});

describe("발송된 것으로 보는 PayPal 상태", () => {
  it("SENT·UNPAID·결제 계열은 발송으로 보고, DRAFT·CANCELLED·SCHEDULED는 아니다", () => {
    expect(["SENT", "UNPAID", "PAID", "MARKED_AS_PAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "SHARED"].every((s) => SENT_LIKE.has(s))).toBe(true);
    expect(["DRAFT", "CANCELLED", "SCHEDULED", "AUTO_CANCELLED", "SOMETHING_NEW"].some((s) => SENT_LIKE.has(s))).toBe(false);
  });
});
