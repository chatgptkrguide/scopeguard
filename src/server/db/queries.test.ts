import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client";
import { DEMO_COPY_MAX_AGE_MS, deleteExpiredCopies, ensureDemoCopy, projectIdForVisitor } from "./demo";
import { runMigrations } from "./migrate";
import { getWorkspace, openVisitorWorkspace } from "./queries";
import { changeOrders, projects } from "./schema";

const NOW = new Date("2026-11-01T09:00:00.000Z");

describe("작업 화면 조회", () => {
  let db: Db;
  let projectId: string;

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
    ({ projectId } = await ensureDemoCopy(db, "visitor-a", NOW));
  });

  const waiveDraftOf = (id: string) =>
    db
      .update(changeOrders)
      .set({ status: "waived" })
      .where(and(eq(changeOrders.projectId, id), eq(changeOrders.status, "draft")));

  it("작업 화면 데이터에 합의 범위·메시지·인용 위치·견적이 모두 들어 있다", async () => {
    const data = await getWorkspace(db, projectId);

    expect(data?.project).toMatchObject({ id: projectId, clientName: "Harbor & Pine Coffee", hourlyRateCents: 5000 });
    expect(data?.scopeItems).toHaveLength(3);
    expect(data?.messages).toHaveLength(4);
    expect(data?.messages.flatMap((m) => m.findings)).toHaveLength(2);
    expect(data?.changeOrders.map((o) => [o.title, o.status])).toEqual([
      ["Gift card page", "paid"],
      ["Loyalty page with customer login", "draft"],
    ]);
    expect(data?.totals).toEqual({ agreedCents: 240000, changeOrdersCents: 90000, totalCents: 330000, paidCents: 25000, hasUnpaid: true });
  });

  it("각 인용에는 그 항목의 견적이 붙어 있다", async () => {
    const data = await getWorkspace(db, projectId);

    const pairs = data?.messages.flatMap((m) => m.findings).map(({ finding, order }) => [finding.title, order?.findingId === finding.id]);
    expect(pairs).toEqual([
      ["Gift card page", true],
      ["Loyalty page with customer login", true],
    ]);
  });

  it("메시지는 보낸 시각 순, 범위 항목은 position 순이다", async () => {
    const data = await getWorkspace(db, projectId);

    const sentAt = data?.messages.map((m) => m.sentAt) ?? [];
    expect(sentAt).toEqual([...sentAt].sort());
    expect(data?.scopeItems.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(data?.scopeItems.map((s) => s.title)).toEqual(["Landing page", "Menu with online ordering", "Contact form"]);
  });

  it("인용 위치로 자른 원문이 저장된 인용과 같다", async () => {
    const data = await getWorkspace(db, projectId);

    for (const message of data?.messages ?? []) {
      for (const { finding } of message.findings) {
        expect(message.body.slice(finding.quoteStart, finding.quoteEnd)).toBe(finding.quote);
      }
    }
  });

  it("다른 사본의 행은 섞이지 않는다", async () => {
    const other = await ensureDemoCopy(db, "visitor-b", NOW);
    await waiveDraftOf(other.projectId);

    const mine = await getWorkspace(db, projectId);
    const theirs = await getWorkspace(db, other.projectId);

    const ownerIds = (d: typeof mine) => [
      ...(d?.scopeItems.map((s) => s.projectId) ?? []),
      ...(d?.messages.map((m) => m.projectId) ?? []),
      ...(d?.changeOrders.map((o) => o.projectId) ?? []),
    ];
    expect(new Set(ownerIds(mine))).toEqual(new Set([projectId]));
    expect(new Set(ownerIds(theirs))).toEqual(new Set([other.projectId]));
    expect(mine?.changeOrders.map((o) => o.status)).toEqual(["paid", "draft"]);
    expect(theirs?.changeOrders.map((o) => o.status)).toEqual(["paid", "waived"]);
    expect(mine?.messages.flatMap((m) => m.findings)).toHaveLength(2);
  });

  it("무료 처리한 견적은 목록에 남고 합계에서는 빠진다", async () => {
    await waiveDraftOf(projectId);

    const data = await getWorkspace(db, projectId);

    expect(data?.changeOrders.map((o) => o.status)).toEqual(["paid", "waived"]);
    expect(data?.messages[3].findings[0].order?.status).toBe("waived");
    expect(data?.totals).toMatchObject({ changeOrdersCents: 25000, totalCents: 265000, hasUnpaid: false });
  });

  it("한 인용에 취소 견적이 여럿이면 만든 순서로 나오고, 둘 다 보낸 적이 없으면 나중에 만든 것을 보여 준다", async () => {
    // Voided drafts (never sent, so sentAt is null), quoted again in turn. The later one has the smaller id, so
    // ordering by id would put it first and show the older one.
    const [loyalty] = await db
      .select({ id: changeOrders.id, findingId: changeOrders.findingId })
      .from(changeOrders)
      .where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, "draft")));
    await db.update(changeOrders).set({ status: "cancelled" }).where(eq(changeOrders.id, loyalty.id));
    const quote = { projectId, findingId: loyalty.findingId, title: "Loyalty page with customer login", hours: 13, amountCents: 65000, extraDays: 3 };
    const older = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const newer = "00000000-0000-4000-8000-000000000000";
    await db.insert(changeOrders).values({ ...quote, id: older, status: "cancelled" });
    await db.insert(changeOrders).values({ ...quote, id: newer, status: "cancelled" });

    const data = await getWorkspace(db, projectId);

    expect(data?.changeOrders.slice(1).map((o) => o.id)).toEqual([loyalty.id, older, newer]);
    expect(data?.messages[3].findings[0].order?.id).toBe(newer);
  });

  it("없는 프로젝트 id면 null을 돌려준다", async () => {
    expect(await getWorkspace(db, "v_doesNotExist0000000000")).toBeNull();
  });

  it("돌려주는 프로젝트에 created_at이 없다", async () => {
    const data = await getWorkspace(db, projectId);

    expect(Object.keys(data?.project ?? {}).sort()).toEqual(
      ["agreedOn", "clientEmail", "clientName", "dueOn", "hourlyRateCents", "hoursPerDay", "id", "title"].sort(),
    );
    expect(data?.project).not.toHaveProperty("createdAt");
    expect(data?.project).not.toHaveProperty("lastSeenAt");
  });
});

describe("방문자 작업 화면 열기", () => {
  let db: Db;
  const later = new Date(NOW.getTime() + DEMO_COPY_MAX_AGE_MS + 2 * 60 * 60 * 1000);

  beforeEach(async () => {
    db = createDb(":memory:");
    await runMigrations(db);
  });

  // Reads like getWorkspace, but the first `racedReads` reads first let another visitor's cleanup delete every copy.
  function racingRead(racedReads: number) {
    const calls = { count: 0 };
    const read: typeof getWorkspace = async (target, projectId) => {
      calls.count += 1;
      if (calls.count <= racedReads) await deleteExpiredCopies(target, new Date(later.getTime() + DEMO_COPY_MAX_AGE_MS + 1));
      return getWorkspace(target, projectId);
    };
    return { read, calls };
  }

  it("처음 온 방문자에게 사본을 만들고 한 번 읽어 화면을 돌려준다", async () => {
    const { read, calls } = racingRead(0);

    const { data, preview } = await openVisitorWorkspace(db, "visitor-a", NOW, { read });

    expect(preview).toBe(false);

    expect(data.project.id).toBe(projectIdForVisitor("visitor-a"));
    expect(data.totals.totalCents).toBe(330000);
    expect(calls.count).toBe(1);
  });

  it("사본을 보장한 뒤 읽기 전에 정리가 그 사본을 지우면 한 번 더 만들어 시드 화면을 돌려준다", async () => {
    await ensureDemoCopy(db, "visitor-a", NOW);
    const { read, calls } = racingRead(1);

    const { data } = await openVisitorWorkspace(db, "visitor-a", later, { read });

    expect(data.project.id).toBe(projectIdForVisitor("visitor-a"));
    expect(data.changeOrders.map((o) => o.status)).toEqual(["paid", "draft"]);
    expect(calls.count).toBe(2);
    expect(await db.select({ id: projects.id }).from(projects)).toEqual([{ id: projectIdForVisitor("visitor-a") }]);
  });

  it("다시 만든 사본도 읽기 전에 지워지면 두 번까지만 시도하고 오류를 낸다", async () => {
    const { read, calls } = racingRead(2);

    await expect(openVisitorWorkspace(db, "visitor-a", later, { read })).rejects.toThrow("demo copy missing after ensure");
    expect(calls.count).toBe(2);
  });
});
