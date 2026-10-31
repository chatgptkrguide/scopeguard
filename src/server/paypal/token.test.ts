import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";
import { PayPalError } from "./errors";
import { authenticationFailure, fakeFetch, internalServerError, invalidClient, invalidToken, tokenResponse } from "../../../test/paypal-fixtures";
import { createPayPalClient, paypalConfig, type PayPalConfig } from "./token";

const CLIENT_ID = "stand-in-client-id";
const CLIENT_SECRET = "stand-in-client-secret-0123456789";
const config: PayPalConfig = paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET }))!;
const TOKEN = "/v1/oauth2/token";
const GET_INVOICE = "/v2/invoicing/invoices/INV2-DZQM-QREH-7LAT-F7YR";
const ok = { status: 200, body: { id: "INV2-DZQM-QREH-7LAT-F7YR", status: "SENT" } };

// A clock the tests move by hand.
function clock(start = 1_793_400_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function failureOf(promise: Promise<unknown>): Promise<PayPalError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PayPalError);
  return error as PayPalError;
}

describe("PayPal 토큰 클라이언트", () => {
  it("토큰을 한 번 받으면 만료 60초 전까지는 다시 요청하지 않는다", async () => {
    const time = clock();
    const paypal = fakeFetch({ [`POST ${TOKEN}`]: { status: 200, body: tokenResponse("A21A-token-1", 3600) }, [`GET ${GET_INVOICE}`]: ok });
    const client = createPayPalClient(config, { fetch: paypal.fetch, now: time.now });

    await client.request({ method: "GET", path: GET_INVOICE });
    time.advance(3600_000 - 60_000 - 1);
    await client.request({ method: "GET", path: GET_INVOICE });

    expect(paypal.to(`POST ${TOKEN}`)).toHaveLength(1);
    expect(paypal.to(`GET ${GET_INVOICE}`).map((c) => c.headers.authorization)).toEqual(["Bearer A21A-token-1", "Bearer A21A-token-1"]);
  });

  it("만료 60초 전이 지나면 새 토큰을 요청한다", async () => {
    const time = clock();
    const paypal = fakeFetch({
      [`POST ${TOKEN}`]: [{ status: 200, body: tokenResponse("A21A-token-1", 3600) }, { status: 200, body: tokenResponse("A21A-token-2", 3600) }],
      [`GET ${GET_INVOICE}`]: ok,
    });
    const client = createPayPalClient(config, { fetch: paypal.fetch, now: time.now });

    await client.request({ method: "GET", path: GET_INVOICE });
    time.advance(3600_000 - 60_000);
    await client.request({ method: "GET", path: GET_INVOICE });

    expect(paypal.to(`POST ${TOKEN}`)).toHaveLength(2);
    expect(paypal.to(`GET ${GET_INVOICE}`)[1].headers.authorization).toBe("Bearer A21A-token-2");
  });

  it("새로 받은 토큰의 남은 시간이 60초보다 짧아도 그 토큰으로 요청한다", async () => {
    const paypal = fakeFetch({ [`POST ${TOKEN}`]: { status: 200, body: tokenResponse("A21A-almost-expired", 30) }, [`GET ${GET_INVOICE}`]: ok });
    const client = createPayPalClient(config, { fetch: paypal.fetch, now: clock().now });

    const res = await client.request({ method: "GET", path: GET_INVOICE });

    expect(res.status).toBe(200);
    expect(paypal.to(`POST ${TOKEN}`)).toHaveLength(1);
    expect(paypal.to(`GET ${GET_INVOICE}`)[0].headers.authorization).toBe("Bearer A21A-almost-expired");
  });

  it("동시에 세 요청이 토큰을 원해도 토큰 요청은 한 번만 나간다", async () => {
    const paypal = fakeFetch({ [`GET ${GET_INVOICE}`]: ok });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    await Promise.all([1, 2, 3].map(() => client.request({ method: "GET", path: GET_INVOICE })));

    expect(paypal.to(`POST ${TOKEN}`)).toHaveLength(1);
    expect(paypal.to(`GET ${GET_INVOICE}`)).toHaveLength(3);
  });

  it("토큰 요청은 Basic 인증과 grant_type=client_credentials 본문으로 보낸다", async () => {
    const paypal = fakeFetch({ [`GET ${GET_INVOICE}`]: ok });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    await client.request({ method: "GET", path: GET_INVOICE });

    const [tokenCall] = paypal.to(`POST ${TOKEN}`);
    expect(tokenCall.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect(tokenCall.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCall.body).toBe("grant_type=client_credentials");
  });

  it("sandbox는 api-m.sandbox.paypal.com, live는 api-m.paypal.com으로 보낸다", async () => {
    const live = paypalConfig(parseEnv({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "wh" }))!;
    const sandboxCalls = fakeFetch({ [`GET ${GET_INVOICE}`]: ok });
    const liveCalls = fakeFetch({ [`GET ${GET_INVOICE}`]: ok });

    await createPayPalClient(config, { fetch: sandboxCalls.fetch }).request({ method: "GET", path: GET_INVOICE });
    await createPayPalClient(live, { fetch: liveCalls.fetch }).request({ method: "GET", path: GET_INVOICE });

    expect(new Set(sandboxCalls.calls.map((c) => new URL(c.url).origin))).toEqual(new Set(["https://api-m.sandbox.paypal.com"]));
    expect(new Set(liveCalls.calls.map((c) => new URL(c.url).origin))).toEqual(new Set(["https://api-m.paypal.com"]));
    expect([config.environment, live.environment]).toEqual(["sandbox", "live"]);
  });

  it("API가 401(invalid_token 모양)을 주면 토큰을 새로 받아 한 번만 다시 보낸다", async () => {
    const paypal = fakeFetch({
      [`POST ${TOKEN}`]: [{ status: 200, body: tokenResponse("A21A-revoked") }, { status: 200, body: tokenResponse("A21A-fresh") }],
      [`GET ${GET_INVOICE}`]: [{ status: 401, body: invalidToken }, ok],
    });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const res = await client.request({ method: "GET", path: GET_INVOICE });

    expect(res.status).toBe(200);
    expect(paypal.to(`GET ${GET_INVOICE}`).map((c) => c.headers.authorization)).toEqual(["Bearer A21A-revoked", "Bearer A21A-fresh"]);
    expect(paypal.to(`POST ${TOKEN}`)).toHaveLength(2);
  });

  it("API가 401(AUTHENTICATION_FAILURE 모양)을 주어도 같은 방법으로 한 번 다시 보낸다", async () => {
    const paypal = fakeFetch({
      [`POST ${TOKEN}`]: [{ status: 200, body: tokenResponse("A21A-old") }, { status: 200, body: tokenResponse("A21A-new") }],
      [`GET ${GET_INVOICE}`]: [{ status: 401, body: authenticationFailure }, ok],
    });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const res = await client.request({ method: "GET", path: GET_INVOICE });

    expect(res.status).toBe(200);
    expect(paypal.to(`GET ${GET_INVOICE}`)).toHaveLength(2);
    expect(paypal.to(`GET ${GET_INVOICE}`)[1].headers.authorization).toBe("Bearer A21A-new");
  });

  it("다시 보내도 401이면 auth 오류로 끝나고 세 번째 요청은 없다", async () => {
    const paypal = fakeFetch({ [`GET ${GET_INVOICE}`]: { status: 401, body: invalidToken } });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const error = await failureOf(client.request({ method: "GET", path: GET_INVOICE }));

    expect([error.failure, error.httpStatus, error.issue]).toEqual(["auth", 401, "invalid_token"]);
    expect(paypal.to(`GET ${GET_INVOICE}`)).toHaveLength(2);
  });

  it("토큰 요청이 401 invalid_client면 다시 시도하지 않고 auth 오류를 낸다", async () => {
    const paypal = fakeFetch({ [`POST ${TOKEN}`]: { status: 401, body: invalidClient }, [`GET ${GET_INVOICE}`]: ok });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const error = await failureOf(client.request({ method: "GET", path: GET_INVOICE }));

    expect([error.failure, error.httpStatus, error.issue]).toEqual(["auth", 401, "invalid_client"]);
    expect(paypal.calls).toHaveLength(1);
  });

  it("토큰 요청이 500이거나 네트워크 오류면 unavailable 오류를 낸다", async () => {
    const server = fakeFetch({ [`POST ${TOKEN}`]: { status: 500, body: internalServerError }, [`GET ${GET_INVOICE}`]: ok });
    const network = fakeFetch({ [`POST ${TOKEN}`]: "network-error", [`GET ${GET_INVOICE}`]: ok });

    const fromServer = await failureOf(createPayPalClient(config, { fetch: server.fetch }).request({ method: "GET", path: GET_INVOICE }));
    const fromNetwork = await failureOf(createPayPalClient(config, { fetch: network.fetch }).request({ method: "GET", path: GET_INVOICE }));

    expect([fromServer.failure, fromServer.httpStatus, fromServer.debugId]).toEqual(["unavailable", 500, "d07c9a1e6b3f5"]);
    expect([fromNetwork.failure, fromNetwork.httpStatus]).toEqual(["unavailable", null]);
    expect(fromNetwork.cause).toBeUndefined();
  });

  it("10초 안에 응답이 없으면 unavailable 오류를 낸다", async () => {
    // The real 10 s limit, shortened: the same AbortSignal.timeout ends the hanging request.
    const paypal = fakeFetch({ [`GET ${GET_INVOICE}`]: "hang" });
    const client = createPayPalClient(config, { fetch: paypal.fetch, timeoutMs: 20 });

    const error = await failureOf(client.request({ method: "GET", path: GET_INVOICE }));

    expect([error.failure, error.httpStatus]).toEqual(["unavailable", null]);
    expect(paypal.to(`GET ${GET_INVOICE}`)).toHaveLength(1);
  });

  it("키가 하나라도 없으면 paypalConfig가 null이다", () => {
    expect(paypalConfig(parseEnv({}))).toBeNull();
    expect(paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "id" }))).toBeNull();
    expect(paypalConfig(parseEnv({ PAYPAL_CLIENT_SECRET: "secret" }))).toBeNull();
    expect(paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" }))).toBeNull();
    expect(paypalConfig(parseEnv({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }))?.baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });

  it("오류 메시지에 client secret과 access token이 들어가지 않는다", async () => {
    const paypal = fakeFetch({
      [`POST ${TOKEN}`]: { status: 200, body: tokenResponse("A21A-secret-token-value") },
      [`GET ${GET_INVOICE}`]: [{ status: 401, body: invalidToken }, { status: 401, body: invalidToken }],
    });
    const badKeys = fakeFetch({ [`POST ${TOKEN}`]: { status: 401, body: invalidClient } });

    const errors = [
      await failureOf(createPayPalClient(config, { fetch: paypal.fetch }).request({ method: "GET", path: GET_INVOICE })),
      await failureOf(createPayPalClient(config, { fetch: badKeys.fetch }).request({ method: "GET", path: GET_INVOICE })),
    ];

    for (const error of errors) {
      const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"));
      expect(text).not.toContain("A21A-secret-token-value");
    }
  });

  it("예상 목록에 든 422는 던지지 않고 issue·debug id와 함께 돌려준다", async () => {
    const paypal = fakeFetch({
      [`POST /v2/invoicing/invoices`]: {
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", debug_id: "f5a1c27e3b9d4", details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] },
      },
    });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const res = await client.request({ method: "POST", path: "/v2/invoicing/invoices", body: {} }, [422]);

    expect(res).toEqual({ status: 422, json: undefined, issue: "DUPLICATE_INVOICE_NUMBER", debugId: "f5a1c27e3b9d4" });
  });

  it("2xx인데 본문을 읽을 수 없으면 unavailable 오류를 낸다", async () => {
    const paypal = fakeFetch({ [`GET ${GET_INVOICE}`]: { status: 200, body: "<html>maintenance</html>" } });
    const client = createPayPalClient(config, { fetch: paypal.fetch });

    const error = await failureOf(client.request({ method: "GET", path: GET_INVOICE }));

    expect([error.failure, error.httpStatus]).toEqual(["unavailable", 200]);
  });
});
