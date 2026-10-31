import { describe, expect, it } from "vitest";
import { createSendLog, SEND_LIMITS, takeSend } from "./send-limit";

const T0 = new Date("2026-11-01T09:00:00.000Z");
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const none = [0, 0] as const;

describe("서버 전체 발송 상한 (P2-S1)", () => {
  it("상한은 분당 10건·하루 200건이다", () => {
    expect(SEND_LIMITS.map((limit) => [limit.windowMs, limit.max])).toEqual([
      [MINUTE, 10],
      [24 * 60 * MINUTE, 200],
    ]);
  });

  it("1분 안에 10건까지 받고 11번째는 거부하며, 거부한 것은 세지 않는다", () => {
    const log = createSendLog();

    const taken = Array.from({ length: 12 }, (_, i) => takeSend(log, at(i * 1000), none));

    expect(taken).toEqual([...Array(10).fill(true), false, false]);
    expect(log.times).toHaveLength(10);
  });

  it("첫 발송에서 1분이 지나면 다시 한 건을 받는다", () => {
    const log = createSendLog();
    for (let i = 0; i < 10; i++) takeSend(log, at(i * 1000), none);

    const justBefore = takeSend(log, at(MINUTE - 1), none);
    const after = takeSend(log, at(MINUTE + 1), none);

    expect([justBefore, after]).toEqual([false, true]);
  });

  it("하루 200건을 넘으면 분당 여유가 있어도 거부한다", () => {
    const log = createSendLog();
    log.times = Array.from({ length: 200 }, (_, i) => T0.getTime() - (i + 2) * 5 * MINUTE); // every 5 minutes, all over a minute ago

    expect(takeSend(log, T0, none)).toBe(false);
    expect(takeSend(log, at(24 * 60 * MINUTE - 1005 * MINUTE - 1), none)).toBe(false); // the oldest is just under a day old
    expect(takeSend(log, at(24 * 60 * MINUTE - 1005 * MINUTE), none)).toBe(true); // a day old: it has left the window
  });

  it("프로세스가 다시 시작돼 로그가 비어도 DB 개수만으로 상한에 걸린다", () => {
    const fresh = createSendLog();

    expect([takeSend(fresh, T0, [10, 10]), takeSend(fresh, T0, [3, 200]), takeSend(fresh, T0, [9, 199])]).toEqual([false, false, true]);
  });

  it("데모 재설정으로 DB 기록이 지워져도(DB 개수 0) 로그 개수만으로 상한에 걸린다", () => {
    const log = createSendLog();
    for (let i = 0; i < 10; i++) takeSend(log, at(i * 1000), none);

    expect(takeSend(log, at(10_000), none)).toBe(false);
  });

  it("하루가 지난 기록은 로그에서 지운다", () => {
    const log = createSendLog();
    log.times = [T0.getTime() - 24 * 60 * MINUTE - 1, T0.getTime() - MINUTE * 2];

    takeSend(log, T0, none);

    expect(log.times).toEqual([T0.getTime() - MINUTE * 2, T0.getTime()]);
  });
});
