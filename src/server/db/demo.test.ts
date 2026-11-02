import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import {
  DEMO_COPY_MAX_AGE_MS,
  LAST_SEEN_REFRESH_MS,
  deleteExpiredCopies,
  demoRows,
  ensureDemoCopy,
  projectIdForVisitor,
  resetDemoCopy,
} from "./demo";
import { runMigrations } from "./migrate";
import { changeOrders, findings, messages, projects, scopeItems } from "./schema";

const T0 = new Date("2026-11-01T09:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

async function freshDb(): Promise<Db> {
  const db = createDb(":memory:");
  await runMigrations(db);
  return db;
}

async function rowsOf(db: Db, projectId: string) {
  const projectMessages = await db.select().from(messages).where(eq(messages.projectId, projectId)).orderBy(messages.sentAt);
  const messageIds = projectMessages.map((m) => m.id);
  return {
    project: await db.select().from(projects).where(eq(projects.id, projectId)),
    scopeItems: await db.select().from(scopeItems).where(eq(scopeItems.projectId, projectId)).orderBy(scopeItems.position),
    messages: projectMessages,
    findings: messageIds.length
      ? await db.select().from(findings).where(inArray(findings.messageId, messageIds)).orderBy(findings.quoteStart)
      : [],
    changeOrders: await db.select().from(changeOrders).where(eq(changeOrders.projectId, projectId)).orderBy(changeOrders.title),
  };
}

function childIds(rows: Awaited<ReturnType<typeof rowsOf>>): string[] {
  return [...rows.scopeItems, ...rows.messages, ...rows.findings, ...rows.changeOrders].map((r) => r.id);
}

async function rowCount(db: Db, projectId: string): Promise<number> {
  const rows = await rowsOf(db, projectId);
  return rows.project.length + childIds(rows).length;
}

function without(row: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
}

// Row contents with ids replaced by positions, so two copies (or a copy before and after reset) compare equal.
async function contentOf(db: Db, projectId: string) {
  const rows = await rowsOf(db, projectId);
  const messageAt = (id: string) => rows.messages.findIndex((m) => m.id === id);
  const findingAt = (id: string) => rows.findings.findIndex((f) => f.id === id);
  return {
    project: rows.project.map((p) => without(p, ["id", "createdAt", "lastSeenAt"])),
    scopeItems: rows.scopeItems.map((s) => without(s, ["id", "projectId"])),
    messages: rows.messages.map((m) => without(m, ["id", "projectId"])),
    findings: rows.findings.map((f) => ({ ...without(f, ["id", "messageId"]), message: messageAt(f.messageId) })),
    changeOrders: rows.changeOrders.map((o) => ({ ...without(o, ["id", "projectId", "findingId"]), finding: findingAt(o.findingId) })),
  };
}

async function draftOrderOf(db: Db, projectId: string) {
  const rows = await rowsOf(db, projectId);
  const draft = rows.changeOrders.find((o) => o.status === "draft");
  if (!draft) throw new Error("the seed has a draft change order");
  return draft;
}

describe("데모 사본", () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("사본 둘은 프로젝트 id와 자식 행 id가 모두 달라 서로 독립이다", async () => {
    const a = await ensureDemoCopy(db, "visitor-a", T0);
    const b = await ensureDemoCopy(db, "visitor-b", T0);

    const idsA = childIds(await rowsOf(db, a.projectId));
    const idsB = childIds(await rowsOf(db, b.projectId));

    expect(a.projectId).not.toBe(b.projectId);
    expect(idsA).toHaveLength(11);
    expect(idsB.filter((id) => idsA.includes(id))).toEqual([]);
    expect(await contentOf(db, a.projectId)).toEqual(await contentOf(db, b.projectId));
  });

  it("한 사본의 견적을 무료 처리해도 다른 사본의 견적은 그대로다", async () => {
    const a = await ensureDemoCopy(db, "visitor-a", T0);
    const b = await ensureDemoCopy(db, "visitor-b", T0);
    const draftA = await draftOrderOf(db, a.projectId);

    await db.update(changeOrders).set({ status: "waived" }).where(eq(changeOrders.id, draftA.id));

    const ordersB = (await rowsOf(db, b.projectId)).changeOrders;
    expect(ordersB.map((o) => o.status)).toEqual(["paid", "draft"]);
  });

  it("같은 방문자로 동시에 두 번 만들어도 사본은 하나이고 행 수는 12개다", async () => {
    const results = await Promise.all([ensureDemoCopy(db, "visitor-a", T0), ensureDemoCopy(db, "visitor-a", T0)]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await db.select().from(projects)).toHaveLength(1);
    expect(await rowCount(db, results[0].projectId)).toBe(12);
  });

  it("이미 있는 사본을 다시 부르면 만들지 않고 같은 사본을 돌려준다", async () => {
    const first = await ensureDemoCopy(db, "visitor-a", T0);

    const second = await ensureDemoCopy(db, "visitor-a", later(1000));

    expect(second).toEqual({ projectId: first.projectId, created: false, refused: false });
    expect(await rowCount(db, first.projectId)).toBe(12);
  });

  it("방문자 id가 같으면 프로젝트 id가 같고, 다르면 다르다", () => {
    expect(projectIdForVisitor("visitor-a")).toBe(projectIdForVisitor("visitor-a"));
    expect(projectIdForVisitor("visitor-a")).not.toBe(projectIdForVisitor("visitor-b"));
  });

  it("프로젝트 id에는 방문자 id가 그대로 들어 있지 않고 v_로 시작하는 24자다", () => {
    const visitorId = "Abc123_-Abc123_-Abc123_-Abc123_-Abc123_-Abc";

    const projectId = projectIdForVisitor(visitorId);

    expect(projectId).toMatch(/^v_[A-Za-z0-9_-]{22}$/);
    expect(projectId).not.toContain(visitorId.slice(0, 8));
  });

  it("행 만들기는 DB 없이 같은 내용과 매번 새 자식 id를 만든다", () => {
    let n = 0;
    const newId = () => `id-${++n}`;

    const first = demoRows("p", T0, newId);
    const second = demoRows("p", T0, newId);

    expect(first.findings[0].messageId).toBe(first.messages[2].id);
    expect(first.changeOrders[1].findingId).toBe(first.findings[1].id);
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
    expect(first.project).toEqual({ ...second.project });
    expect(first.project.createdAt).toBe("2026-11-01T09:00:00.000Z");
    expect(first.project.lastSeenAt).toBe("2026-11-01T09:00:00.000Z");
  });
});

describe("데모 사본 재설정", () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
  });

  it("재설정하면 id를 뺀 행 내용이 처음 시드와 같다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);
    const seeded = await contentOf(db, projectId);
    await db.update(changeOrders).set({ status: "waived" }).where(eq(changeOrders.id, (await draftOrderOf(db, projectId)).id));

    await resetDemoCopy(db, projectId, later(60_000));

    expect(await contentOf(db, projectId)).toEqual(seeded);
    expect(await rowCount(db, projectId)).toBe(12);
  });

  it("재설정하면 자식 행 id가 모두 새것으로 바뀐다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);
    const before = childIds(await rowsOf(db, projectId));

    await resetDemoCopy(db, projectId, later(60_000));

    const after = childIds(await rowsOf(db, projectId));
    expect(after).toHaveLength(before.length);
    expect(after.filter((id) => before.includes(id))).toEqual([]);
  });

  it("재설정하면 만든 시각과 마지막 사용 시각이 재설정한 시각이 된다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);

    await resetDemoCopy(db, projectId, later(60_000));

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project.createdAt).toBe(later(60_000).toISOString());
    expect(project.lastSeenAt).toBe(later(60_000).toISOString());
  });

  it("재설정은 그 사본만 바꾸고 다른 사본은 건드리지 않는다", async () => {
    const a = await ensureDemoCopy(db, "visitor-a", T0);
    const b = await ensureDemoCopy(db, "visitor-b", T0);
    await db.update(changeOrders).set({ status: "waived" }).where(eq(changeOrders.id, (await draftOrderOf(db, b.projectId)).id));
    const before = await rowsOf(db, b.projectId);

    await resetDemoCopy(db, a.projectId, later(60_000));

    expect(await rowsOf(db, b.projectId)).toEqual(before);
  });

  it("없는 프로젝트 id로 재설정하면 그 id로 시드를 새로 만든다", async () => {
    await resetDemoCopy(db, "demo", T0);

    expect(await rowCount(db, "demo")).toBe(12);
  });
});

describe("마지막 사용 시각과 7일 정리", () => {
  let db: Db;

  beforeEach(async () => {
    db = await freshDb();
  });

  const lastSeenOf = async (projectId: string) =>
    (await db.select({ at: projects.lastSeenAt }).from(projects).where(eq(projects.id, projectId)))[0]?.at;

  it("사본을 연 지 1시간이 지났으면 마지막 사용 시각을 지금으로 바꾼다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);

    await ensureDemoCopy(db, "visitor-a", later(LAST_SEEN_REFRESH_MS + 1));

    expect(await lastSeenOf(projectId)).toBe(later(LAST_SEEN_REFRESH_MS + 1).toISOString());
  });

  it("1시간 안에 다시 열면 마지막 사용 시각을 바꾸지 않는다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);

    await ensureDemoCopy(db, "visitor-a", later(LAST_SEEN_REFRESH_MS));

    expect(await lastSeenOf(projectId)).toBe(T0.toISOString());
  });

  it("7일이 지난 사본만 지우고 그 자식 행도 함께 지운다", async () => {
    const old = await ensureDemoCopy(db, "visitor-old", T0);
    const fresh = await ensureDemoCopy(db, "visitor-fresh", later(DEMO_COPY_MAX_AGE_MS));

    const deleted = await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS + 1));

    expect(deleted).toBe(1);
    expect(await rowCount(db, old.projectId)).toBe(0);
    expect(await rowCount(db, fresh.projectId)).toBe(12);
    expect(await db.select().from(findings)).toHaveLength(2);
  });

  it("정확히 7일 된 사본은 남기고 7일하고 1ms 지난 사본은 지운다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);

    const atLimit = await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS));
    const pastLimit = await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS + 1));

    expect(atLimit).toBe(0);
    expect(pastLimit).toBe(1);
    expect(await rowCount(db, projectId)).toBe(0);
  });

  it("오래전에 만들었어도 최근에 연 사본은 지우지 않는다", async () => {
    const { projectId } = await ensureDemoCopy(db, "visitor-a", T0);
    await ensureDemoCopy(db, "visitor-a", later(6 * 24 * 60 * 60 * 1000));

    const deleted = await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS + 1));

    expect(deleted).toBe(0);
    expect(await rowCount(db, projectId)).toBe(12);
  });

  it("새 사본을 만들 때 7일 지난 사본을 지운다", async () => {
    const old = await ensureDemoCopy(db, "visitor-old", T0);

    const created = await ensureDemoCopy(db, "visitor-new", later(DEMO_COPY_MAX_AGE_MS + 1));

    expect(created.created).toBe(true);
    expect(await rowCount(db, old.projectId)).toBe(0);
    expect(await rowCount(db, created.projectId)).toBe(12);
  });

  it("지워진 사본의 방문자가 다시 오면 같은 프로젝트 id로 새 사본을 받는다", async () => {
    const first = await ensureDemoCopy(db, "visitor-a", T0);
    await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS + 1));

    const again = await ensureDemoCopy(db, "visitor-a", later(DEMO_COPY_MAX_AGE_MS + 2));

    expect(again).toEqual({ projectId: first.projectId, created: true, refused: false });
    expect(await rowCount(db, again.projectId)).toBe(12);
  });

  it("사본을 여러 개 만든 뒤에도 외래 키 검사가 비어 있다", async () => {
    for (const visitor of ["a", "b", "c"]) await ensureDemoCopy(db, visitor, T0);
    await resetDemoCopy(db, projectIdForVisitor("b"), later(1000));
    await deleteExpiredCopies(db, later(DEMO_COPY_MAX_AGE_MS + 1));
    await ensureDemoCopy(db, "d", later(DEMO_COPY_MAX_AGE_MS + 1));

    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    // a and c expired; b was reset a second later, so it is still inside the seven days.
    const left = (await db.select({ id: projects.id }).from(projects)).map((p) => p.id).sort();
    expect(left).toEqual([projectIdForVisitor("b"), projectIdForVisitor("d")].sort());
  });
});

describe("데모 시드 내용", () => {
  let db: Db;
  let projectId: string;

  beforeEach(async () => {
    db = await freshDb();
    ({ projectId } = await ensureDemoCopy(db, "visitor-a", T0));
  });

  it("합의 범위 $2,400과 추가 견적 2건(결제 1·초안 1)을 만든다", async () => {
    const rows = await rowsOf(db, projectId);

    expect(rows.scopeItems.reduce((sum, i) => sum + i.amountCents, 0)).toBe(240000);
    expect(rows.changeOrders.map((o) => [o.title, o.amountCents, o.status])).toEqual([
      ["Gift card page", 25000, "paid"],
      ["Loyalty page with customer login", 65000, "draft"],
    ]);
  });

  it("추가 일수는 하루 6시간 기준으로 올림한다(5시간 → 1일, 13시간 → 3일)", async () => {
    const rows = await rowsOf(db, projectId);

    expect(rows.changeOrders.map((o) => o.extraDays)).toEqual([1, 3]);
  });

  it("저장한 인용 위치가 메시지 원문의 그 문구를 가리킨다", async () => {
    const rows = await db.select().from(findings).innerJoin(messages, eq(findings.messageId, messages.id));

    expect(rows).toHaveLength(2);
    for (const { findings: f, messages: m } of rows) {
      expect(m.body.slice(f.quoteStart, f.quoteEnd)).toBe(f.quote);
    }
  });
});
