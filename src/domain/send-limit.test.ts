import { describe, expect, it } from "vitest";
import { SEND_LIMITS } from "./send-limit";

const MINUTE = 60 * 1000;

// How the limits are counted is tested with the table that counts them (server/db/paypal-sends.test.ts).
describe("서버 전체 발송 상한 (P2-S1)", () => {
  it("상한은 분당 10건·하루 200건이다", () => {
    expect(SEND_LIMITS.map((limit) => [limit.windowMs, limit.max])).toEqual([
      [MINUTE, 10],
      [24 * 60 * MINUTE, 200],
    ]);
  });
});
