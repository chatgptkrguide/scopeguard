import { NextResponse, type NextRequest } from "next/server";
import { isVisitorId, newVisitorId, VISITOR_COOKIE, visitorCookieOptions } from "@/server/visitor";

// Gives a visitor without a valid demo cookie a new random id, and sets a valid one again with the
// same value so it lasts seven days from the last visit, like the copy it points to. It only issues
// the cookie; pages and server actions read it themselves and decide what the visitor may touch.
export function proxy(request: NextRequest): NextResponse {
  const options = visitorCookieOptions(process.env.NODE_ENV === "production");
  const current = request.cookies.get(VISITOR_COOKIE)?.value;
  if (isVisitorId(current)) {
    const response = NextResponse.next();
    response.cookies.set(VISITOR_COOKIE, current, options);
    return response;
  }

  const id = newVisitorId();
  // Forward the new id with this request too, so the first page render already sees it.
  request.cookies.set(VISITOR_COOKIE, id);
  const response = NextResponse.next({ request: { headers: new Headers(request.headers) } });
  response.cookies.set(VISITOR_COOKIE, id, options);
  return response;
}

export const config = {
  // Webhooks, health checks and static files never get a cookie.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
