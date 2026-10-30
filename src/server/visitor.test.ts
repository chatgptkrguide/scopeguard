import { describe, expect, it } from "vitest";
import { isVisitorId, newVisitorId, VISITOR_COOKIE_MAX_AGE_S, visitorCookieOptions } from "./visitor";

describe("방문자 id", () => {
  it("새 방문자 id는 43자 base64url이고 두 번 만들면 서로 다르다", () => {
    const first = newVisitorId();
    const second = newVisitorId();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("형식 검사는 43자 base64url만 통과시키고 빈 값·42자·+/=가 든 값은 거부한다", () => {
    const valid = "A".repeat(21) + "_-" + "z".repeat(20);

    expect(isVisitorId(valid)).toBe(true);
    expect(isVisitorId(newVisitorId())).toBe(true);
    expect(isVisitorId("")).toBe(false);
    expect(isVisitorId(valid.slice(1))).toBe(false);
    expect(isVisitorId(valid + "A")).toBe(false);
    expect(isVisitorId("+" + valid.slice(1))).toBe(false);
    expect(isVisitorId("/" + valid.slice(1))).toBe(false);
    expect(isVisitorId(valid.slice(1) + "=")).toBe(false);
    expect(isVisitorId(undefined)).toBe(false);
    expect(isVisitorId(42)).toBe(false);
  });

  it("쿠키 옵션은 HttpOnly·SameSite=Lax·Path=/·7일이고 secure 인자를 그대로 쓴다", () => {
    expect(visitorCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 604800 });
    expect(visitorCookieOptions(false).secure).toBe(false);
    expect(VISITOR_COOKIE_MAX_AGE_S).toBe(7 * 24 * 60 * 60);
  });
});
