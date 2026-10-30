import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

describe("환경변수 검증", () => {
  it("아무것도 없으면 샌드박스와 로컬 DB 파일을 기본값으로 쓴다", () => {
    const env = parseEnv({});

    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.DATABASE_URL).toBe("file:data/scopeguard.db");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it(".env.example을 그대로 복사한 빈 값은 설정 안 된 것으로 본다", () => {
    const env = parseEnv({ PAYPAL_CLIENT_ID: "", ANTHROPIC_API_KEY: "", DATABASE_URL: "" });

    expect(env.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBe("file:data/scopeguard.db");
  });

  it("알 수 없는 PayPal 환경 이름은 거부한다", () => {
    expect(() => parseEnv({ PAYPAL_ENV: "production" })).toThrow();
  });

  it("PAYPAL_ENV가 빈 값이면 샌드박스로 본다", () => {
    expect(parseEnv({ PAYPAL_ENV: "" }).PAYPAL_ENV).toBe("sandbox");
  });

  it("실제 결제(live)는 키와 웹훅 ID가 모두 있어야 켜진다", () => {
    expect(() => parseEnv({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" })).toThrow(/PAYPAL_WEBHOOK_ID/);
    const env = parseEnv({ PAYPAL_ENV: "live", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_WEBHOOK_ID: "wh" });
    expect(env.PAYPAL_ENV).toBe("live");
  });
});
