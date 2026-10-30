import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "./proxy";
import { isVisitorId, VISITOR_COOKIE } from "./server/visitor";

const VALID_ID = "A".repeat(21) + "_-" + "z".repeat(20);

function requestWith(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/", { headers: cookie ? { cookie } : {} });
}

describe("방문자 쿠키 발급(proxy)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("쿠키가 없으면 새 방문자 id 쿠키를 발급한다", () => {
    const response = proxy(requestWith());

    const issued = response.cookies.get(VISITOR_COOKIE);
    expect(isVisitorId(issued?.value)).toBe(true);
    expect(issued).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 604800 });
  });

  it("운영 모드에서는 Secure를 붙이고 개발 모드에서는 붙이지 않는다", () => {
    vi.stubEnv("NODE_ENV", "production");
    const production = proxy(requestWith()).headers.get("set-cookie") ?? "";
    vi.stubEnv("NODE_ENV", "development");
    const development = proxy(requestWith()).headers.get("set-cookie") ?? "";

    expect(production).toMatch(/;\s*Secure/i);
    expect(production).toMatch(/;\s*HttpOnly/i);
    expect(production).toMatch(/;\s*SameSite=Lax/i);
    expect(development).not.toMatch(/Secure/i);
    expect(development).toMatch(/;\s*HttpOnly/i);
  });

  it("올바른 쿠키가 있으면 새로 발급하지 않는다", () => {
    const response = proxy(requestWith(`${VISITOR_COOKIE}=${VALID_ID}`));

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.cookies.get(VISITOR_COOKIE)).toBeUndefined();
  });

  it("형식이 틀린 쿠키는 새 id로 바꾼다", () => {
    const response = proxy(requestWith(`${VISITOR_COOKIE}=forged-or-cut`));

    const issued = response.cookies.get(VISITOR_COOKIE)?.value;
    expect(isVisitorId(issued)).toBe(true);
    expect(issued).not.toBe("forged-or-cut");
  });

  it("새 id는 같은 요청의 페이지가 읽도록 요청 쿠키 헤더에도 들어간다", () => {
    const response = proxy(requestWith("theme=dark"));

    const issued = response.cookies.get(VISITOR_COOKIE)?.value;
    // Internal header Next.js uses to hand the rewritten request headers to the page (NextResponse.next({ request })).
    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).toContain(`${VISITOR_COOKIE}=${issued}`);
    expect(forwarded).toContain("theme=dark");
  });

  it("matcher는 /에는 맞고 웹훅·정적 파일·파비콘에는 맞지 않는다", () => {
    // The docs call this unstable_doesProxyMatch; Next 16.4.2 still exports it under the middleware name.
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

    expect(matches("/")).toBe(true);
    expect(matches("/api/webhooks/paypal")).toBe(false);
    expect(matches("/api/health")).toBe(false);
    expect(matches("/_next/static/x.js")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
  });
});
