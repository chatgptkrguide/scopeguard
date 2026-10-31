import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P2 (d) and (e) acceptance checks that need no PayPal. The bundle scan needs a build (`pnpm build` / `pnpm e2e`).

const firstLine = (file: string) => readFileSync(file, "utf8").split("\n")[0].trim();
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("P2 (d) 비밀 값이 브라우저로 새지 않는다", () => {
  it("P2 (d) 토큰·청구서·billing 모듈의 첫 줄은 import \"server-only\"다", () => {
    for (const file of ["src/server/paypal/token.ts", "src/server/paypal/invoices.ts", "src/server/billing.ts"]) {
      expect(firstLine(file), file).toBe('import "server-only";');
    }
  });

  it.skipIf(!existsSync(".next/static"))("P2 (d) .next/static 아래에 PAYPAL_CLIENT_SECRET 이름도 값도 없다(찾은 개수만 확인)", () => {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const secret = process.env.PAYPAL_CLIENT_SECRET ?? "";
    const files = walk(".next/static");
    let nameHits = 0;
    let valueHits = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (text.includes("PAYPAL_CLIENT_SECRET")) nameHits++;
      if (secret.length >= 8 && text.includes(secret)) valueHits++;
    }
    expect(files.length).toBeGreaterThan(0);
    expect({ nameHits, valueHits }).toEqual({ nameHits: 0, valueHits: 0 });
  });
});

describe("P2 (e) 오류 4종 시험이 있다", () => {
  it("P2 (e) invoices.test.ts에 401·422·5xx/네트워크·이미 발송/취소 시험이 각각 있다", () => {
    const text = readFileSync("src/server/paypal/invoices.test.ts", "utf8");
    for (const name of ["401 토큰 만료", "422 검증 오류", "5xx와 네트워크 오류", "이미 발송·이미 취소"]) {
      expect(text, name).toContain(`오류 4종 — ${name}`);
    }
  });
});
