import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookReply } from "@/server/webhook";
import { POST } from "./route";

// Only the handler's answer is replaced; this checks how the route turns it into a response.
const handler = vi.hoisted(() => ({ reply: async (): Promise<WebhookReply> => ({ status: 200, outcome: "settled" }) }));

vi.mock("@/server/webhook", () => ({
  liveWebhookDeps: () => ({}),
  receivePayPalWebhook: () => handler.reply(),
}));

const request = () => new Request("https://tollgate.example/api/webhooks/paypal", { method: "POST", body: "{}" });

describe("웹훅 라우트 응답", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("200이면 본문은 received true뿐이고 캐시하지 않는다", async () => {
    handler.reply = async () => ({ status: 200, outcome: "duplicate" });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("오류면 본문은 오류 코드 하나뿐이다", async () => {
    handler.reply = async () => ({ status: 400, outcome: "unverified" });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unverified" });
  });

  it("상한에 걸린 503에는 Retry-After 헤더가 붙는다", async () => {
    handler.reply = async () => ({ status: 503, outcome: "busy", retryAfterSeconds: 60 });

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "busy" });
  });

  it("처리 중 예상 못 한 오류가 나면 500 server_error이고 오류 내용을 돌려주지 않는다", async () => {
    handler.reply = async () => Promise.reject(new Error("database is locked at /var/data/tollgate.db"));

    const res = await POST(request());
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "server_error" });
    expect(text).not.toContain("locked");
  });
});
