import { count } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "./db/client";
import { ensureDemoCopy, projectIdForVisitor } from "./db/demo";
import { runMigrations } from "./db/migrate";
import { openVisitorWorkspace } from "./db/queries";
import { activityEvents, changeOrders, findings, messages, projects, scopeItems } from "./db/schema";
import { AddressLimiter, clientAddress, DAY_MS, demoCopyGate, IP_WINDOW_MS, NEW_COPIES_PER_IP_PER_HOUR } from "./demo-limit";
import { newVisitorId } from "./visitor";

const T0 = new Date("2026-11-01T09:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

async function freshDb(): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  return db;
}

async function projectCount(db: Db): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(projects);
  return n;
}

async function totalRows(db: Db): Promise<number> {
  let total = 0;
  for (const table of [projects, scopeItems, messages, findings, changeOrders, activityEvents]) {
    const [{ n }] = await db.select({ n: count() }).from(table);
    total += n;
  }
  return total;
}

// What GET / does for a request without a cookie: proxy.ts issues a new visitor id, then the page opens it.
async function cookielessVisit(db: Db, address: string | null, now: Date, limiter: AddressLimiter, dailyCap?: number) {
  return openVisitorWorkspace(db, newVisitorId(), now, { mayCreate: demoCopyGate(address, { limiter, dailyCap }) });
}

describe("새 데모 사본 제한", () => {
  let db: Db;
  let limiter: AddressLimiter;

  beforeEach(async () => {
    db = await freshDb();
    limiter = new AddressLimiter();
  });

  it("재현: 제한이 없으면 쿠키 없는 GET 20번이 사본 20개를 만든다", async () => {
    for (let i = 0; i < 20; i++) await openVisitorWorkspace(db, newVisitorId(), T0);

    expect(await projectCount(db)).toBe(20);
  });

  it("같은 IP의 쿠키 없는 GET 20번은 사본을 시간당 한도만큼만 만들고, 나머지는 쓰지 않고 시드를 미리 보여 준다", async () => {
    const results = [];
    for (let i = 0; i < 20; i++) results.push(await cookielessVisit(db, "203.0.113.7", T0, limiter));

    expect(await projectCount(db)).toBe(NEW_COPIES_PER_IP_PER_HOUR);
    expect(results.filter((r) => !r.preview)).toHaveLength(NEW_COPIES_PER_IP_PER_HOUR);
    const rowsAfterLimit = await totalRows(db);

    // Refused visitors still get the whole demo on their first screen.
    for (const { data } of results.filter((r) => r.preview)) {
      expect(data.scopeItems).toHaveLength(3);
      expect(data.messages).toHaveLength(4);
      expect(data.messages.flatMap((m) => m.findings)).toHaveLength(2);
      expect(data.changeOrders.map((o) => [o.title, o.status])).toEqual([
        ["Gift card page", "paid"],
        ["Loyalty page with customer login", "draft"],
      ]);
      expect(data.totals.totalCents).toBe(330000);
    }
    await cookielessVisit(db, "203.0.113.7", T0, limiter);
    expect(await totalRows(db)).toBe(rowsAfterLimit);
  });

  it("미리보기 화면은 진짜 사본의 첫 화면과 id를 빼면 같다", async () => {
    const real = await openVisitorWorkspace(db, "visitor-real", T0);
    const preview = await openVisitorWorkspace(db, "visitor-preview", T0, { mayCreate: async () => false });

    expect(real.preview).toBe(false);
    expect(preview.preview).toBe(true);
    expect(preview.data.project.id).toBe(projectIdForVisitor("visitor-preview"));
    expect(preview.data.project).not.toHaveProperty("createdAt");
    expect(preview.data.project).not.toHaveProperty("lastSeenAt");
    const shape = (data: typeof real.data) =>
      JSON.parse(JSON.stringify(data), (key, value) => (key === "id" || key.endsWith("Id") ? undefined : value));
    expect(shape(preview.data)).toEqual(shape(real.data));
    expect(await projectCount(db)).toBe(1);
  });

  it("IP 한도는 한 시간이 지나면 다시 채워지고, 다른 IP에는 따로 센다", async () => {
    for (let i = 0; i < NEW_COPIES_PER_IP_PER_HOUR; i++) await cookielessVisit(db, "203.0.113.7", T0, limiter);

    expect((await cookielessVisit(db, "203.0.113.7", later(IP_WINDOW_MS - 1), limiter)).preview).toBe(true);
    expect((await cookielessVisit(db, "198.51.100.2", later(IP_WINDOW_MS - 1), limiter)).preview).toBe(false);
    expect((await cookielessVisit(db, "203.0.113.7", later(IP_WINDOW_MS), limiter)).preview).toBe(false);
  });

  it("서버 전체 하루 상한은 IP가 모두 달라도 지키고, 24시간이 지나면 다시 만든다", async () => {
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await cookielessVisit(db, `198.51.100.${i}`, T0, limiter, 5));

    expect(await projectCount(db)).toBe(5);
    expect(results.map((r) => r.preview)).toEqual([false, false, false, false, false, true, true, true]);
    expect((await cookielessVisit(db, "198.51.100.99", later(DAY_MS - 1), limiter, 5)).preview).toBe(true);
    expect((await cookielessVisit(db, "198.51.100.99", later(DAY_MS), limiter, 5)).preview).toBe(false);
  });

  it("하루 상한에 걸린 요청은 그 IP의 한도를 쓰지 않는다", async () => {
    for (let i = 0; i < 3; i++) await cookielessVisit(db, `198.51.100.${i}`, T0, limiter, 3);
    for (let i = 0; i < 20; i++) await cookielessVisit(db, "203.0.113.7", T0, limiter, 3);

    expect(limiter.take("203.0.113.7", T0)).toBe(true);
  });

  it("IP를 모르면(로컬·브라우저 테스트) 하루 상한만 적용한다", async () => {
    for (let i = 0; i < NEW_COPIES_PER_IP_PER_HOUR + 5; i++) await cookielessVisit(db, null, T0, limiter);

    expect(await projectCount(db)).toBe(NEW_COPIES_PER_IP_PER_HOUR + 5);
  });

  it("이미 사본이 있는 방문자는 한도를 넘어도 자기 사본을 그대로 연다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);
    const gate = vi.fn(async () => false);

    const opened = await openVisitorWorkspace(db, "visitor-a", later(1000), { mayCreate: gate });

    expect(opened.preview).toBe(false);
    expect(opened.data.project.id).toBe(projectId);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("AddressLimiter", () => {
  it("기억하는 주소 수가 상한에 닿으면 끝난 창부터 지우고, 그래도 많으면 모두 비운다", () => {
    const limiter = new AddressLimiter(1, IP_WINDOW_MS, 3);
    for (const address of ["a", "b", "c"]) limiter.take(address, T0);

    limiter.take("d", later(1));
    expect(limiter.size).toBe(1);

    for (const address of ["e", "f"]) limiter.take(address, later(2));
    limiter.take("g", later(IP_WINDOW_MS + 2)); // d, e and f have finished their window
    expect(limiter.size).toBe(1);
  });
});

describe("clientAddress", () => {
  const headersOf = (init: Record<string, string>) => new Headers(init);

  it("X-Forwarded-For의 첫 주소를 쓰고, 없으면 X-Real-IP, 둘 다 없으면 null이다", () => {
    expect(clientAddress(headersOf({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(headersOf({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientAddress(headersOf({}))).toBeNull();
    expect(clientAddress(headersOf({ "x-forwarded-for": "x".repeat(500) }))).toHaveLength(64);
  });

  it("next start가 채우는 loopback 주소는 모르는 주소(null)로 본다", () => {
    for (const loopback of ["::1", "127.0.0.1", "::ffff:127.0.0.1"]) {
      expect(clientAddress(headersOf({ "x-forwarded-for": loopback }))).toBeNull();
    }
    expect(clientAddress(headersOf({ "x-forwarded-for": "1270::1" }))).toBe("1270::1");
  });
});
