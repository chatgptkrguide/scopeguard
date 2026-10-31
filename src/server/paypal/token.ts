import "server-only";
import { env, type Env } from "../env";
import { PayPalError, failureForStatus, parseErrorBody } from "./errors";

// PayPal REST client: one OAuth token per server process, shared by every request, and one retry on 401.
// The client secret and the access token stay inside this file; errors carry only status, issue and debug id.

export type PayPalEnvironment = Env["PAYPAL_ENV"];

const BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const satisfies Record<PayPalEnvironment, string>;

export interface PayPalConfig {
  environment: PayPalEnvironment; // decides which payer links are accepted (see safePayerViewUrl)
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

// Null when either key is missing. The screen then keeps the send button off.
export function paypalConfig(source: Env = env()): PayPalConfig | null {
  const { PAYPAL_ENV, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = source;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) return null;
  return { environment: PAYPAL_ENV, baseUrl: BASE_URLS[PAYPAL_ENV], clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET };
}

export interface PayPalRequest {
  method: "GET" | "POST" | "DELETE";
  path: string; // after baseUrl, e.g. "/v2/invoicing/invoices"
  body?: unknown; // sent as JSON.stringify(body)
  rawBody?: string; // sent byte for byte (already JSON). Never together with `body`.
  headers?: Readonly<Record<string, string>>; // PayPal-Request-Id, Prefer
}

export interface PayPalResponse {
  status: number; // a 2xx, or one of the statuses the caller listed in `expect`
  json: unknown; // undefined for an empty body (204)
  issue: string | null; // set for an expected error status
  debugId: string | null;
}

export interface PayPalClient {
  readonly environment: PayPalEnvironment;
  // Returns 2xx answers and the error statuses listed in `expect` (e.g. 422, which the invoice calls
  // read by issue name). Every other status throws a PayPalError.
  request(req: PayPalRequest, expect?: readonly number[]): Promise<PayPalResponse>;
  // Gets an access token (or reuses the cached one). Throws a PayPalError as request() does. Used by /api/health.
  checkToken(): Promise<void>;
}

export interface PayPalClientOptions {
  fetch?: typeof fetch; // tests
  now?: () => number; // tests; defaults to Date.now
  timeoutMs?: number; // per HTTP request
  refreshMarginMs?: number; // a token this close to expiring is replaced
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number; // ms, on the `now` clock
}

interface RawResponse {
  status: number;
  text: string;
  debugHeader: string | null;
}

export function createPayPalClient(config: PayPalConfig, options: PayPalClientOptions = {}): PayPalClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;

  let cached: CachedToken | null = null;
  let pending: Promise<string> | null = null;

  // One HTTP exchange. A thrown fetch (network, timeout) becomes `unavailable`; the original error is
  // dropped on purpose, so nothing from the request (headers included) can reach a log through `cause`.
  async function exchange(url: string, init: RequestInit): Promise<RawResponse> {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, text: await res.text(), debugHeader: res.headers.get("paypal-debug-id") };
    } catch {
      throw new PayPalError("unavailable", null, null, null);
    }
  }

  async function fetchToken(): Promise<CachedToken> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await exchange(`${config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    if (res.status < 200 || res.status > 299) {
      const { issue, debugId } = parseErrorBody(res.text, res.debugHeader);
      // Any other 4xx from the token endpoint means the keys are wrong; retrying won't help.
      const failure = failureForStatus(res.status) === "unavailable" ? "unavailable" : "auth";
      throw new PayPalError(failure, res.status, issue, debugId);
    }
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new PayPalError("unavailable", res.status, null, null);
    }
    const token = typeof body === "object" && body !== null && "access_token" in body ? body.access_token : undefined;
    const expiresIn = typeof body === "object" && body !== null && "expires_in" in body ? body.expires_in : undefined;
    if (typeof token !== "string" || token === "" || typeof expiresIn !== "number") {
      throw new PayPalError("unavailable", res.status, null, null);
    }
    return { token, expiresAt: now() + expiresIn * 1000 };
  }

  // A cached token is reused until refreshMarginMs before it expires. A freshly fetched one is used even
  // if it expires sooner than that: PayPal hands back the same token until it expires, so asking again
  // would only repeat the answer. Concurrent callers share one token request.
  function accessToken(): Promise<string> {
    if (cached && now() < cached.expiresAt - refreshMarginMs) return Promise.resolve(cached.token);
    pending ??= fetchToken()
      .then((fresh) => {
        cached = fresh;
        return fresh.token;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  function call(req: PayPalRequest, token: string): Promise<RawResponse> {
    if (req.body !== undefined && req.rawBody !== undefined) throw new TypeError("a PayPal request takes body or rawBody, not both");
    const body = req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
    const headers: Record<string, string> = { ...req.headers, Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return exchange(`${config.baseUrl}${req.path}`, { method: req.method, headers, body });
  }

  return {
    environment: config.environment,
    async checkToken() {
      await accessToken();
    },
    async request(req, expect = []) {
      let token = await accessToken();
      let res = await call(req, token);
      // An expired or revoked token: drop it (unless another request already replaced it) and try once more.
      if (res.status === 401) {
        if (cached?.token === token) cached = null;
        token = await accessToken();
        res = await call(req, token);
      }

      if (res.status >= 200 && res.status <= 299) {
        if (res.text === "") return { status: res.status, json: undefined, issue: null, debugId: res.debugHeader };
        try {
          return { status: res.status, json: JSON.parse(res.text) as unknown, issue: null, debugId: res.debugHeader };
        } catch {
          throw new PayPalError("unavailable", res.status, null, res.debugHeader);
        }
      }
      const { issue, debugId } = parseErrorBody(res.text, res.debugHeader);
      if (expect.includes(res.status)) return { status: res.status, json: undefined, issue, debugId };
      throw new PayPalError(failureForStatus(res.status), res.status, issue, debugId);
    },
  };
}

let shared: PayPalClient | undefined;

// The server's one client, so every request shares the token cache. Null without keys.
export function getPayPal(): PayPalClient | null {
  const config = paypalConfig();
  if (!config) return null;
  shared ??= createPayPalClient(config);
  return shared;
}
