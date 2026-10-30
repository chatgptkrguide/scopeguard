import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { demoRows } from "./demo";
import { isUniqueViolation } from "./errors";
import { runMigrations } from "./migrate";
import { changeOrders, findings, messages, projects, scopeItems } from "./schema";

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to fail");
}

describe("고유 제약 위반 판정", () => {
  let db: Db;
  const rows = demoRows("p-test", new Date("2026-11-01T00:00:00Z"));

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    await db.batch([
      db.insert(projects).values(rows.project),
      db.insert(scopeItems).values(rows.scopeItems),
      db.insert(messages).values(rows.messages),
      db.insert(findings).values(rows.findings),
      db.insert(changeOrders).values(rows.changeOrders),
    ]);
  });

  it("고유 제약 위반은 batch 오류와 단일 쿼리 오류 모두 isUniqueViolation이 알아본다", async () => {
    const fromBatch = await errorOf(db.batch([db.insert(projects).values(rows.project)]));
    const fromQuery = await errorOf(db.insert(projects).values(rows.project));

    expect(isUniqueViolation(fromBatch)).toBe(true);
    expect(isUniqueViolation(fromQuery)).toBe(true);
  });

  it("기본 키가 아닌 고유 열(청구서 번호)이 겹쳐도 고유 제약 위반으로 본다", async () => {
    const [first, second] = rows.changeOrders;
    await db.update(changeOrders).set({ paypalInvoiceId: "INV2-SAME" }).where(eq(changeOrders.id, first.id));

    const duplicate = await errorOf(
      db.update(changeOrders).set({ paypalInvoiceId: "INV2-SAME" }).where(eq(changeOrders.id, second.id)),
    );

    expect(isUniqueViolation(duplicate)).toBe(true);
  });

  it("CHECK 위반이나 일반 오류는 고유 제약 위반이 아니다", async () => {
    const checkFailure = await errorOf(db.update(projects).set({ hourlyRateCents: 0 }).where(eq(projects.id, "p-test")));

    expect(isUniqueViolation(checkFailure)).toBe(false);
    expect(isUniqueViolation(new Error("SQLITE_CONSTRAINT_UNIQUE"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("SQLITE_CONSTRAINT_PRIMARYKEY")).toBe(false);
  });
});
