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

  it("겹치면 더 긴 인용을 남기고 위치 순으로 정렬한다", () => {
    const found = locateFindings(body, [
      draft("customers log in"),
      draft("add a loyalty page where customers log in to see their stamps"),
      draft("loyalty page"),
      draft("at launch", { title: "Launch date" }),
    ]);
    expect(found.map((f) => f.quote)).toEqual(["add a loyalty page where customers log in to see their stamps", "at launch"]);
  });

  it("같은 문구가 두 번 나오면 두 번째 표시는 두 번째 위치를 가리킨다", () => {
    const twice = "Please add a gallery page. Also, add a gallery page for the second shop.";

    const found = locateFindings(twice, [
      draft("add a gallery page", { title: "Gallery" }),
      draft("add a gallery page", { title: "Second gallery" }),
    ]);

    expect(found.map((f) => [f.title, f.start])).toEqual([
      ["Gallery", twice.indexOf("add a gallery page")],
      ["Second gallery", twice.lastIndexOf("add a gallery page")],
    ]);
  });

  it("곧은 따옴표와 둥근 따옴표는 같은 글자로 보고, 저장하는 인용은 원문 그대로다", () => {
    const curly = "Could we add a “members only” page? It’s for our VIPs.";

    const [f] = locateFindings(curly, [draft('add a "members only" page', { title: "Members page" })]);

    expect(f.quote).toBe("add a “members only” page");
    expect(curly.slice(f.start, f.end)).toBe(f.quote);
  });

  it("모델이 같은 표시를 그대로 두 번 내면 하나만 남긴다", () => {
    const twice = "Please add a gallery page. Also, add a gallery page for the second shop.";

    const found = locateFindings(twice, [draft("add a gallery page"), draft("add a gallery page")]);

    expect(found).toHaveLength(1);
  });
});
