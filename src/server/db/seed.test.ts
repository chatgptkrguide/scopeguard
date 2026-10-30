import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";
import { changeOrders, findings, messages, projects, scopeItems } from "./schema";
import { DEMO_PROJECT_ID, seedDemo } from "./seed";

describe("데모 프로젝트 시드", () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
  });

  it("합의 범위 $2,400과 추가 견적 2건(결제 1·초안 1)을 만든다", async () => {
    await seedDemo(db);

    const items = await db.select().from(scopeItems).where(eq(scopeItems.projectId, DEMO_PROJECT_ID));
    const orders = await db.select().from(changeOrders).where(eq(changeOrders.projectId, DEMO_PROJECT_ID));

    expect(items.reduce((sum, i) => sum + i.amountCents, 0)).toBe(240000);
    expect(orders.map((o) => [o.title, o.amountCents, o.status])).toEqual([
      ["Gift card page", 25000, "paid"],
      ["Loyalty page with customer login", 65000, "draft"],
    ]);
  });

  it("추가 일수는 하루 6시간 기준으로 올림한다(5시간 → 1일, 13시간 → 3일)", async () => {
    await seedDemo(db);

    const orders = await db.select().from(changeOrders).where(eq(changeOrders.projectId, DEMO_PROJECT_ID));

    expect(orders.map((o) => o.extraDays)).toEqual([1, 3]);
  });

  it("저장한 인용 위치가 메시지 원문의 그 문구를 가리킨다", async () => {
    await seedDemo(db);

    const rows = await db.select().from(findings).innerJoin(messages, eq(findings.messageId, messages.id));

    for (const { findings: f, messages: m } of rows) {
      expect(m.body.slice(f.quoteStart, f.quoteEnd)).toBe(f.quote);
    }
  });

  it("두 번 실행해도 데모 프로젝트는 하나뿐이다", async () => {
    await seedDemo(db);
    await seedDemo(db);

    const rows = await db.select().from(projects);
    expect(rows).toHaveLength(1);
    expect(await db.select().from(changeOrders)).toHaveLength(2);
  });
});
