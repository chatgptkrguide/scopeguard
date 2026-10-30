import { describe, expect, it } from "vitest";
import { formatShortDate } from "./dates";

describe("짧은 날짜 표시", () => {
  it("ISO 날짜와 날짜시각을 UTC 기준 \"Oct 21\" 형식으로 바꾼다", () => {
    expect(formatShortDate("2026-10-21")).toBe("Oct 21");
    expect(formatShortDate("2026-10-21T08:12:00Z")).toBe("Oct 21");
    expect(formatShortDate("2026-11-05T00:00:00.000Z")).toBe("Nov 5");
  });

  it("UTC 자정 직전 시각도 하루 밀리지 않는다", () => {
    expect(formatShortDate("2026-10-21T23:59:00Z")).toBe("Oct 21");
    expect(formatShortDate("2026-10-21T00:00:00Z")).toBe("Oct 21");
  });

  it("날짜가 아닌 값은 받은 글자를 그대로 돌려준다", () => {
    expect(formatShortDate("not a date")).toBe("not a date");
  });
});
