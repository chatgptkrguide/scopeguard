import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEBHOOK_ID,
  fakeFetch,
  internalServerError,
  invalidClient,
  paidEvent,
  signatureHeaders,
  verifyFailure,
  verifyInvalidRequest,
  verifySuccess,
  verifyValidationError,
  type FakeReply,
} from "../../../test/paypal-fixtures";
import { parseEnv } from "../env";
import { PayPalError } from "./errors";
import { createPayPalClient, paypalConfig } from "./token";
import { readWebhookHeaders, verificationBody, verifyWebhookSignature, type WebhookHeaders } from "./webhooks";

const VERIFY = "POST /v1/notifications/verify-webhook-signature";
const config = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "stand-in-client-id", PAYPAL_CLIENT_SECRET: "stand-in-client-secret-0123456789" }))!;

function client(reply: FakeReply | readonly FakeReply[], options: { timeoutMs?: number } = {}) {
  const fake = fakeFetch({ [VERIFY]: reply });
  return { ...fake, client: createPayPalClient(config, { fetch: fake.fetch, ...options }) };
}

const headers = readWebhookHeaders(new Headers(signatureHeaders))!;
const rawEvent = JSON.stringify(paidEvent("INV2-DZQM-QREH-7LAT-F7YR", "0244f9b8-b8ac-4e6b-b86d-f3d648c071e0"), null, 2);

describe("웹훅 서명 확인 요청 (verify-webhook-signature)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("검증 요청은 일곱 필드를 담고 Authorization Bearer로 간다", async () => {
    const pp = client({ status: 200, body: verifySuccess });

    await verifyWebhookSignature(pp.client, WEBHOOK_ID, headers, rawEvent);

    const [call] = pp.to(VERIFY);
    expect(call.headers.authorization).toBe("Bearer A21A-stand-in-token-1");
    expect(call.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(call.body!) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["auth_algo", "cert_url", "transmission_id", "transmission_sig", "transmission_time", "webhook_event", "webhook_id"]);
    expect(sent).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: signatureHeaders["paypal-cert-url"],
      transmission_id: signatureHeaders["paypal-transmission-id"],
      transmission_sig: signatureHeaders["paypal-transmission-sig"],
      transmission_time: signatureHeaders["paypal-transmission-time"],
      webhook_id: WEBHOOK_ID,
    });
  });

  it("webhook_event 자리에는 받은 본문이 바이트 그대로 들어간다(공백·키 순서·유니코드 이스케이프 유지)", async () => {
    const pp = client({ status: 200, body: verifySuccess });
    const odd = '{"z":1,  "id":"WH-1","event_type":"X","note":"caf\\u00e9 é","a":[ 1 ,2 ]}';

    await verifyWebhookSignature(pp.client, WEBHOOK_ID, headers, odd);

    const body = pp.to(VERIFY)[0].body!;
    expect(body.endsWith(`,"webhook_event":${odd}}`)).toBe(true);
    expect(body).toBe(verificationBody(WEBHOOK_ID, headers, odd));
  });

  it("200 SUCCESS는 verified다", async () => {
    expect(await verifyWebhookSignature(client({ status: 200, body: verifySuccess }).client, WEBHOOK_ID, headers, rawEvent)).toBe("verified");
  });

  it("200 FAILURE는 unverified다", async () => {
    expect(await verifyWebhookSignature(client({ status: 200, body: verifyFailure }).client, WEBHOOK_ID, headers, rawEvent)).toBe("unverified");
  });

  it("400 INVALID_REQUEST와 400 VALIDATION_ERROR(실측 본문 모양)는 unverified다", async () => {
    const invalid = await verifyWebhookSignature(client({ status: 400, body: verifyInvalidRequest }).client, WEBHOOK_ID, headers, rawEvent);
    const validation = await verifyWebhookSignature(client({ status: 400, body: verifyValidationError }).client, WEBHOOK_ID, headers, rawEvent);

    expect([invalid, validation]).toEqual(["unverified", "unverified"]);
  });

  it("422도 unverified다", async () => {
    expect(await verifyWebhookSignature(client({ status: 422, body: {} }).client, WEBHOOK_ID, headers, rawEvent)).toBe("unverified");
  });

  it("401이 두 번이면(재시도 뒤에도) auth PayPalError로 던진다", async () => {
    const pp = client({ status: 401, body: invalidClient });

    await expect(verifyWebhookSignature(pp.client, WEBHOOK_ID, headers, rawEvent)).rejects.toMatchObject({ failure: "auth", httpStatus: 401 });
    expect(pp.to(VERIFY)).toHaveLength(2);
  });

  it("500·네트워크 오류·시간 초과는 unavailable PayPalError로 던진다", async () => {
    const failures = await Promise.all([
      verifyWebhookSignature(client({ status: 500, body: internalServerError }).client, WEBHOOK_ID, headers, rawEvent).catch((e: unknown) => e),
      verifyWebhookSignature(client("network-error").client, WEBHOOK_ID, headers, rawEvent).catch((e: unknown) => e),
      verifyWebhookSignature(client("hang", { timeoutMs: 20 }).client, WEBHOOK_ID, headers, rawEvent).catch((e: unknown) => e),
    ]);

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(PayPalError);
      expect(failure).toMatchObject({ failure: "unavailable" });
    }
  });

  it("2xx인데 SUCCESS도 FAILURE도 아니면 확인된 것으로 보지 않고 unavailable로 던진다", async () => {
    await expect(verifyWebhookSignature(client({ status: 200, body: {} }).client, WEBHOOK_ID, headers, rawEvent)).rejects.toMatchObject({ failure: "unavailable" });
  });
});

describe("웹훅 서명 헤더 읽기", () => {
  const read = (overrides: Record<string, string | null>): WebhookHeaders | null => {
    const h = new Headers(signatureHeaders);
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) h.delete(name);
      else h.set(name, value);
    }
    return readWebhookHeaders(h);
  };

  it("다섯 헤더가 모두 있으면 값을 그대로 읽는다(이름은 대소문자를 가리지 않는다)", () => {
    const upper = new Headers(Object.entries(signatureHeaders).map(([name, value]): [string, string] => [name.toUpperCase(), value]));

    expect(readWebhookHeaders(upper)).toEqual({
      authAlgo: "SHA256withRSA",
      certUrl: signatureHeaders["paypal-cert-url"],
      transmissionId: signatureHeaders["paypal-transmission-id"],
      transmissionSig: signatureHeaders["paypal-transmission-sig"],
      transmissionTime: signatureHeaders["paypal-transmission-time"],
    });
  });

  it("헤더 하나라도 없으면 null이다", () => {
    for (const name of Object.keys(signatureHeaders)) expect(read({ [name]: null }), name).toBeNull();
  });

  it("헤더 길이·패턴을 넘으면 null이다", () => {
    expect(read({ "paypal-auth-algo": "SHA256-with-RSA" })).toBeNull();
    expect(read({ "paypal-auth-algo": "A".repeat(101) })).toBeNull();
    expect(read({ "paypal-cert-url": "http://api.sandbox.paypal.com/v1/notifications/certs/CERT" })).toBeNull();
    expect(read({ "paypal-cert-url": "not a url" })).toBeNull();
    expect(read({ "paypal-cert-url": `https://api.sandbox.paypal.com/${"a".repeat(480)}` })).toBeNull();
    expect(read({ "paypal-transmission-id": "a".repeat(51) })).toBeNull();
    expect(read({ "paypal-transmission-id": "has space" })).toBeNull();
    expect(read({ "paypal-transmission-sig": "s".repeat(501) })).toBeNull();
    expect(read({ "paypal-transmission-time": "t".repeat(101) })).toBeNull();
    expect(read({ "paypal-transmission-time": "" })).toBeNull();
  });

  it("길이가 딱 상한이면 받는다", () => {
    expect(read({ "paypal-auth-algo": "A".repeat(100), "paypal-transmission-id": "a".repeat(50), "paypal-transmission-sig": "s".repeat(500), "paypal-transmission-time": "t".repeat(100) })).not.toBeNull();
  });
});
