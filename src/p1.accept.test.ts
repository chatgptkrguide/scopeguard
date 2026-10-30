import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("P1 (e) 옛 샘플 데이터 파일", () => {
  it("P1 (e) src/lib/sample.ts 파일이 없다", () => {
    expect(existsSync(join(root, "src/lib/sample.ts"))).toBe(false);
  });

  it("P1 (e) 어떤 소스도 lib/sample을 가져오지 않는다", () => {
    const offenders = sourceFiles(join(root, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("p1.accept.test.ts"))
      .filter((f) => /lib\/sample/.test(readFileSync(f, "utf8")));

    expect(offenders).toEqual([]);
  });
});
