import { describe, expect, it } from "vitest";
import { segmentBody, type BodySegment, type MarkSpan } from "./segments";

const joined = (segments: BodySegment[]) => segments.map((s) => s.text).join("");

describe("본문을 저장된 인용 위치로 나누기", () => {
  it("저장된 위치로 나누고, 같은 문구가 두 번 있어도 저장된 위치만 표시한다", () => {
    const body = "add a page, then add a page again";
    const second = body.lastIndexOf("add a page");

    const segments = segmentBody(body, [{ id: "f1", start: second, end: second + 10, quote: "add a page" }]);

    expect(segments).toEqual([
      { kind: "text", text: "add a page, then " },
      { kind: "mark", text: "add a page", id: "f1" },
      { kind: "text", text: " again" },
    ]);
  });

  it("여러 위치는 시작 순서대로 표시하고 맨 앞·맨 뒤 표시도 다룬다", () => {
    const body = "gift cards and a loyalty page";

    const segments = segmentBody(body, [
      { id: "b", start: 17, end: 29, quote: "loyalty page" },
      { id: "a", start: 0, end: 10, quote: "gift cards" },
    ]);

    expect(segments.map((s) => (s.kind === "mark" ? `[${s.id}]` : s.text))).toEqual(["[a]", " and a ", "[b]"]);
  });

  it("범위를 벗어난 위치는 표시하지 않고 원문은 그대로 둔다", () => {
    const body = "short text";
    const spans: MarkSpan[] = [
      { id: "neg", start: -1, end: 3, quote: "sho" },
      { id: "long", start: 6, end: 20, quote: "text" },
      { id: "empty", start: 3, end: 3, quote: "" },
      { id: "back", start: 5, end: 2, quote: "" },
    ];

    expect(segmentBody(body, spans)).toEqual([{ kind: "text", text: body }]);
  });

  it("겹치는 위치는 앞의 것만 표시한다", () => {
    const body = "add a loyalty page with login";

    const segments = segmentBody(body, [
      { id: "later", start: 14, end: 29, quote: "page with login" },
      { id: "first", start: 0, end: 18, quote: "add a loyalty page" },
    ]);

    expect(segments.filter((s) => s.kind === "mark").map((s) => s.kind === "mark" && s.id)).toEqual(["first"]);
    expect(joined(segments)).toBe(body);
  });

  it("위치의 글자가 인용과 다르면 표시하지 않는다", () => {
    const body = "The menu looks great";

    expect(segmentBody(body, [{ id: "f", start: 4, end: 8, quote: "MENU" }])).toEqual([{ kind: "text", text: body }]);
  });

  it("조각을 이으면 언제나 원문과 같다", () => {
    const body = "Could you also add a loyalty page? And gift cards, please.";
    const cases: MarkSpan[][] = [
      [],
      [{ id: "a", start: 15, end: 33, quote: "add a loyalty page" }],
      [
        { id: "a", start: 15, end: 33, quote: "add a loyalty page" },
        { id: "b", start: 39, end: 49, quote: "gift cards" },
        { id: "c", start: 0, end: 500, quote: "x" },
      ],
    ];

    for (const spans of cases) expect(joined(segmentBody(body, spans))).toBe(body);
    expect(segmentBody("", [])).toEqual([]);
  });
});
