import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { invoiceNumberFor } from "@/domain/invoice";
import { cancelOwnedChangeOrder, invoiceGateway, requoteOwnedChangeOrder, sendOwnedChangeOrder, type BillingDeps } from "@/server/billing";
import { listActivity } from "@/server/db/activity";
import { createDb, type Db } from "@/server/db/client";
import { ensureDemoCopy } from "@/server/db/demo";
import { runMigrations } from "@/server/db/migrate";
import { changeOrders } from "@/server/db/schema";
import { parseEnv } from "@/server/env";
import { createInvoice, getInvoice } from "@/server/paypal/invoices";
import { createPayPalClient, paypalConfig, type PayPalClient } from "@/server/paypal/token";

// P2 acceptance checks against the real PayPal sandbox (WP 2.2.6). Run with `pnpm accept:sandbox`.
// Every invoice a check touches is remembered; afterAll cancels the sent ones and deletes the drafts.

const config = paypalConfig(parseEnv(process.env as Record<string, string | undefined>));
const LOG = process.env.P2_ACCEPT_LOG; // optional file that collects touched invoice ids

describe.skipIf(!config)("P2 인수 시험 — PayPal 샌드박스", () => {
  let client: PayPalClient;
  let dir: string;
  const touched = new Map<string, string>(); // invoice id -> change order id
  const orderIds = new Set<string>();
  const cleaned: string[] = [];

  async function newDb(file?: string): Promise<Db> {
    const db = createDb(file ?? ":memory:");
    return db;
  }
  async function freshCopy(db: Db, visitor: string) {
    const { projectId } = await ensureDemoCopy(db, visitor, new Date());
    const draft = (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.status, "draft"))))[0];
    orderIds.add(draft.id);
    return { projectId, draft };
  }
  const deps = (db: Db): BillingDeps => ({ db, paypal: invoiceGateway(client), now: () => new Date() });

  // All invoices PayPal has for this invoice number (search by number, retried while PayPal's index catches up).
  async function searchByNumber(number: string, expectAtLeast = 1) {
    let items: Array<{ id: string; status: string }> = [];
    for (let i = 0; i < 8; i++) {
      const res = await client.request({ method: "POST", path: "/v2/invoicing/search-invoices", body: { invoice_number: number } });
      const raw = (res.json as { items?: Array<{ id: string; status: string; detail: { invoice_number: string } }> }).items ?? [];
      items = raw.filter((x) => x.detail.invoice_number === number);
      if (items.length >= expectAtLeast) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return items;
  }
  const remember = (orderId: string, ids: Array<string | null | undefined>) => {
    for (const id of ids) if (id) touched.set(id, orderId);
    if (LOG) for (const id of ids) if (id) appendFileSync(LOG, `${id}\n`);
  };

  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    client = createPayPalClient(config!);
    dir = mkdtempSync(join(tmpdir(), "p2-accept-"));
  });

  afterAll(async () => {
    // Anything PayPal holds under our change-order numbers, even if a check failed halfway.
    for (const orderId of orderIds) {
      try {
        const found = await searchByNumber(invoiceNumberFor(orderId), 0);
        for (const item of found) touched.set(item.id, orderId);
      } catch {
        /* best effort */
      }
    }
    for (const id of touched.keys()) {
      try {
        const inv = await getInvoice(client, id);
        if (inv.status === "DRAFT") {
          await client.request({ method: "DELETE", path: `/v2/invoicing/invoices/${id}` });
          cleaned.push(`${id} DRAFT deleted`);
        } else if (["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"].includes(inv.status)) {
          await client.request({ method: "POST", path: `/v2/invoicing/invoices/${id}/cancel`, body: { send_to_recipient: false, send_to_invoicer: false } }, [422]);
          cleaned.push(`${id} ${inv.status} cancelled`);
        } else cleaned.push(`${id} ${inv.status} left as is`);
      } catch (error) {
        cleaned.push(`${id} CLEANUP FAILED ${(error as Error).message}`);
      }
    }
    console.info("P2 sandbox invoices:\n" + [...touched.keys()].map((id) => id).join("\n") + "\ncleanup:\n" + cleaned.join("\n"));
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("P2 (b) 같은 견적을 동시에 두 번 발송하면 PayPal 검색에서 그 청구서 번호는 정확히 1건이다", async () => {
    const db = await newDb();
    await runMigrations(db);
    const { projectId, draft } = await freshCopy(db, "p2-b-same-db");

    const results = await Promise.all([sendOwnedChangeOrder(deps(db), projectId, draft.id), sendOwnedChangeOrder(deps(db), projectId, draft.id)]);

    const row = (await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0];
    remember(draft.id, [row.paypalInvoiceId]);
    const found = await searchByNumber(invoiceNumberFor(draft.id));
    remember(draft.id, found.map((f) => f.id));
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(row.paypalInvoiceId);
    expect(row.status).toBe("sent");
  });

  it("P2 (b) 서로 다른 DB 연결(서버 프로세스 둘에 해당)에서 동시에 발송해도 청구서는 1건이다", async () => {
    const file = `file:${join(dir, "two-conn.db")}`;
    const first = await newDb(file);
    await runMigrations(first);
    const second = await newDb(file);
    const { projectId, draft } = await freshCopy(first, "p2-b-two-conn");

    const results = await Promise.all([sendOwnedChangeOrder(deps(first), projectId, draft.id), sendOwnedChangeOrder(deps(second), projectId, draft.id)]);

    const row = (await first.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0];
    remember(draft.id, [row.paypalInvoiceId]);
    const found = await searchByNumber(invoiceNumberFor(draft.id));
    remember(draft.id, found.map((f) => f.id));
    expect(results.some((r) => r.ok)).toBe(true);
    expect(found).toHaveLength(1);
  });

  it("P2 (b) 청구서를 PayPal에만 만들고 id를 저장하지 못한 뒤 다시 발송해도 같은 청구서 1건으로 끝난다", async () => {
    const db = await newDb();
    await runMigrations(db);
    const { projectId, draft } = await freshCopy(db, "p2-b-orphan");
    const orphan = await createInvoice(client, {
      changeOrderId: draft.id,
      title: draft.title,
      description: "P2 accept orphan",
      note: "P2 acceptance check",
      amountCents: draft.amountCents,
      recipient: { email: "maya@harborandpine.example", businessName: "Harbor & Pine" },
    });
    remember(draft.id, [orphan.id]);

    const result = await sendOwnedChangeOrder(deps(db), projectId, draft.id);

    const row = (await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0];
    const found = await searchByNumber(invoiceNumberFor(draft.id));
    remember(draft.id, found.map((f) => f.id));
    expect(result).toEqual({ ok: true });
    expect(row.paypalInvoiceId).toBe(orphan.id);
    expect(found).toHaveLength(1);
  });

  it("P2 (c) (f) (g) 발송한 견적의 결제 링크는 HTTP 200이고, 취소하면 CANCELLED이며 다시 견적하면 같은 항목의 새 초안이 생기고, 활동 기록이 시간 순서다", async () => {
    const db = await newDb();
    await runMigrations(db);
    const { projectId, draft } = await freshCopy(db, "p2-cfg");

    expect(await sendOwnedChangeOrder(deps(db), projectId, draft.id)).toEqual({ ok: true });
    const sent = (await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0];
    remember(draft.id, [sent.paypalInvoiceId]);

    // (c)
    expect(sent.payerViewUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\//);
    const page = await fetch(sent.payerViewUrl!, { redirect: "follow" });
    expect(page.status).toBe(200);
    expect((await getInvoice(client, sent.paypalInvoiceId!)).status).toMatch(/^(SENT|UNPAID)$/);

    // (f)
    expect(await cancelOwnedChangeOrder(deps(db), projectId, draft.id)).toEqual({ ok: true });
    expect((await getInvoice(client, sent.paypalInvoiceId!)).status).toBe("CANCELLED");
    expect((await db.select().from(changeOrders).where(eq(changeOrders.id, draft.id)))[0].status).toBe("cancelled");
    expect(await requoteOwnedChangeOrder(db, projectId, draft.id)).toEqual({ ok: true });
    const again = (await db.select().from(changeOrders).where(and(eq(changeOrders.projectId, projectId), eq(changeOrders.findingId, draft.findingId!), eq(changeOrders.status, "draft"))))[0];
    expect(again).toBeDefined();
    expect(again.id).not.toBe(draft.id);
    expect(again.title).toBe(draft.title);
    expect(again.hours).toBe(draft.hours);
    expect(again.amountCents).toBe(draft.amountCents);
    // the requoted order can be sent: new invoice number, new invoice
    expect(await sendOwnedChangeOrder(deps(db), projectId, again.id)).toEqual({ ok: true });
    orderIds.add(again.id);
    const second = (await db.select().from(changeOrders).where(eq(changeOrders.id, again.id)))[0];
    remember(again.id, [second.paypalInvoiceId]);
    expect(second.paypalInvoiceId).not.toBe(sent.paypalInvoiceId);

    // (g)
    const events = (await listActivity(db, projectId)).filter((e) => e.changeOrderId === draft.id);
    expect(events.map((e) => e.kind)).toEqual(["invoice_created", "invoice_sent", "invoice_cancelled"]);
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b));
  });
});
