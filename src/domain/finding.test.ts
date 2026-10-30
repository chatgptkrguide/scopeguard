import { describe, expect, it } from "vitest";
import { locateFindings, type FindingDraft } from "./finding";

const body =
  "The menu looks great so far! Could you also add a loyalty page where customers log in to see their stamps? Our investors want it at launch.";

const draft = (quote: string, overrides: Partial<FindingDraft> = {}): FindingDraft => ({
  quote,
  title: "Loyalty page",
  estimatedHours: 13,
  reason: "Customer accounts are not in version 1.",
  ...overrides,
});

describe("locateFindings", () => {
  it("메시지를 그대로 인용한 표시만 위치와 함께 남긴다", () => {
    const [f] = locateFindings(body, [draft("add a loyalty page where customers log in to see their stamps")]);
    expect(body.slice(f.start, f.end)).toBe(f.quote);
  });

  it("모델이 바꿔 쓴 인용은 버린다", () => {
    expect(locateFindings(body, [draft("add a loyalty program page")])).toEqual([]);
  });

  it("빈 제목과 말이 안 되는 시간 추정은 버린다", () => {
    expect(locateFindings(body, [draft("Our investors", { title: " " })])).toEqual([]);
    expect(locateFindings(body, [draft("Our investors", { estimatedHours: 0 })])).toEqual([]);
    expect(locateFindings(body, [draft("Our investors", { estimatedHours: 500 })])).toEqual([]);
  });

  it("겹치는 인용은 앞의 것만 남기고 위치 순으로 정렬한다", () => {
    const found = locateFindings(body, [
      draft("customers log in"),
      draft("add a loyalty page where customers log in to see their stamps"),
      draft("loyalty page"),
      draft("at launch", { title: "Launch date" }),
    ]);
    expect(found.map((f) => f.quote)).toEqual(["add a loyalty page where customers log in to see their stamps", "at launch"]);
  });
});
