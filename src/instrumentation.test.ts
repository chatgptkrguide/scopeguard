import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "./instrumentation";

// Only the startup work is replaced; this checks when register() runs it.
const startup = vi.hoisted(() => ({ startServer: vi.fn<() => Promise<void>>() }));
vi.mock("./server/startup", () => startup);

describe("서버 시작 훅 (instrumentation register)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Node.js 서버에서는 시작 검사와 마이그레이션을 끝낸 뒤에 돌아온다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    let finished = false;
    startup.startServer.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await register();

    expect(startup.startServer).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
  });

  it("NEXT_RUNTIME이 nodejs가 아니면(edge) 아무것도 하지 않는다", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");

    await register();

    expect(startup.startServer).not.toHaveBeenCalled();
  });
});
