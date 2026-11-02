import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// render.yaml read as text (no YAML parser in the project): each check looks at one service-level line or one
// envVars entry.
const text = readFileSync("render.yaml", "utf8");
const lines = text.split("\n");
const setting = (key: string) => lines.find((line) => new RegExp(`^ {4}${key}:`).test(line))?.replace(/#.*$/, "").split(":").slice(1).join(":").trim();

// The lines of one envVars entry, from its "- key:" line up to the next entry.
function envEntry(name: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `- key: ${name}`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("- key:"));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
}

describe("Render 배포 설정 (render.yaml)", () => {
  it("render.yaml의 자동 배포는 문자열 \"off\"이고 배포 브랜치는 deploy다", () => {
    expect(setting("autoDeployTrigger")).toBe('"off"');
    expect(setting("branch")).toBe("deploy");
    expect(text).not.toMatch(/autoDeploy:\s*true/);
  });

  it("render.yaml의 디스크는 /var/data에 붙고 DATABASE_URL은 그 아래다", () => {
    expect(lines.some((line) => line.trim() === "mountPath: /var/data")).toBe(true);
    expect(envEntry("DATABASE_URL")).toEqual(["- key: DATABASE_URL", "value: file:/var/data/tollgate.db"]);
    expect(envEntry("PAYPAL_ENV")).toEqual(["- key: PAYPAL_ENV", "value: sandbox"]);
  });

  it("render.yaml의 헬스 체크 경로는 /api/health/live이고 시크릿 키는 모두 sync false다", () => {
    expect(setting("healthCheckPath")).toBe("/api/health/live");
    for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "ANTHROPIC_API_KEY"]) {
      expect(envEntry(name), name).toEqual([`- key: ${name}`, "sync: false"]);
    }
  });

  it("render.yaml의 시작 명령은 pnpm start이고 빌드는 잠긴 lockfile로 설치한다", () => {
    expect(setting("startCommand")).toBe("pnpm start");
    expect(setting("buildCommand")).toBe("pnpm install --frozen-lockfile && pnpm build");
    expect(setting("plan")).toBe("0.5c-512mb");
  });

  it("render.yaml은 Node 버전을 NODE_VERSION으로 .nvmrc와 같은 22에 고정한다", () => {
    const nvmrc = readFileSync(".nvmrc", "utf8").trim();

    expect(envEntry("NODE_VERSION")).toEqual(["- key: NODE_VERSION", 'value: "22"']);
    expect(nvmrc).toBe("22");
  });
});
