import { liveWebhookDeps, receivePayPalWebhook, type WebhookReply } from "@/server/webhook";

// PayPal's payment webhook. The work is in src/server/webhook.ts; this only turns its answer into a response. The
// body says only whether the event was received or which error code applies: nothing from the request or from PayPal.
export async function POST(request: Request): Promise<Response> {
  let reply: WebhookReply;
  try {
    reply = await receivePayPalWebhook(liveWebhookDeps(), request);
  } catch (error) {
    console.error("handling a PayPal webhook failed", error);
    reply = { status: 500, outcome: "server_error" };
  }
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (reply.status === 503 && reply.retryAfterSeconds !== undefined) headers["Retry-After"] = String(reply.retryAfterSeconds);
  return Response.json(reply.status === 200 ? { received: true } : { error: reply.outcome }, { status: reply.status, headers });
}
