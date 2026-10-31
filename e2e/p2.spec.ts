import { appendFileSync, existsSync } from "node:fs";
import { createClient } from "@libsql/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

if (existsSync(".env.local")) process.loadEnvFile(".env.local"); // the test process calls PayPal directly

const DB_URL = "file:data/e2e-paypal.db"; // the keyed server's database (playwright.config.ts)
const API = "https://api-m.sandbox.paypal.com";
const LOG = process.env.P2_ACCEPT_LOG;
const SEND = "Send change order";
const OPEN_CANCEL = "Cancel invoice";
const CONFIRM_CANCEL = "Confirm: cancel the invoice";
const REQUOTE = "Quote again";

const note = (page: Page, id?: string) => (id ? page.locator(`aside[data-change-order-id="${id}"]`) : page.locator('aside[data-status="draft"][data-change-order-id]').first());
const idOf = (page: Page) => note(page).getAttribute("data-change-order-id");

async function open(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("workspace")).toBeVisible();
  return { context, page };
}

async function token(): Promise<string> {
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  return ((await res.json()) as { access_token: string }).access_token;
}
async function paypal(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function rows<T = Record<string, unknown>>(sql: string, args: Array<string | number> = []): Promise<T[]> {
  const db = createClient({ url: DB_URL });
  try {
    return (await db.execute({ sql, args })).rows as unknown as T[];
  } finally {
    db.close();
  }
}
const orderRow = async (id: string) =>
  (await rows<{ status: string; paypal_invoice_id: string | null; payer_view_url: string | null; finding_id: string; title: string; amount_cents: number }>("SELECT status, paypal_invoice_id, payer_view_url, finding_id, title, amount_cents FROM change_orders WHERE id = ?", [id]))[0];
const touched = new Set<string>();
const remember = (id: string | null | undefined) => {
  if (!id) return;
  touched.add(id);
  if (LOG) appendFileSync(LOG, `${id}\n`);
};

test.describe("P2 인수 시험 (키 있는 서버)", () => {
  test.setTimeout(150_000);
  test.afterAll(async () => {
    // Cancel what was sent, delete what is still a draft; also anything the database still lists.
    for (const r of await rows<{ paypal_invoice_id: string }>("SELECT paypal_invoice_id FROM change_orders WHERE paypal_invoice_id IS NOT NULL")) remember(r.paypal_invoice_id);
    for (const id of touched) {
      const inv = await paypal("GET", `/v2/invoicing/invoices/${id}`);
      if (inv.status !== 200) continue;
      if (inv.json.status === "DRAFT") await paypal("DELETE", `/v2/invoicing/invoices/${id}`);
      else if (["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.json.status)) await paypal("POST", `/v2/invoicing/invoices/${id}/cancel`, { send_to_recipient: false, send_to_invoicer: false });
    }
  });

  test("P2 (c) (f) (g) 발송하면 Sent와 결제 링크가 보이고, 결제 화면에 청구서 번호·금액이 있고, 확인 뒤 취소하면 CANCELLED이며 Quote again으로 같은 항목이 다시 견적된다", async ({ browser }, info) => {
    const { context, page } = await open(browser);
    const orderId = (await idOf(page))!;
    const before = await orderRow(orderId);

    // send
    await note(page, orderId).getByRole("button", { name: SEND }).click();
    await expect(note(page, orderId).getByRole("status")).toContainText("Sent to client", { timeout: 40_000 });
    const link = note(page, orderId).getByRole("link", { name: /client's PayPal page/ });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute("href"))!;
    const sent = await orderRow(orderId);
    remember(sent.paypal_invoice_id);
    expect(sent.status).toBe("sent");
    expect(href).toBe(sent.payer_view_url);
    expect(href).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\//);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `test-results/screens/p2-sent.png`, fullPage: true });

    // (c) the pay page opens (200) and shows this invoice's number and amount
    const invoice = await paypal("GET", `/v2/invoicing/invoices/${sent.paypal_invoice_id}`);
    const invoiceNumber: string = invoice.json.detail.invoice_number;
    const amount = Number(invoice.json.amount.value).toLocaleString("en-US", { minimumFractionDigits: 2 });
    expect(amount).toBe((before.amount_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }));
    const payer = await context.newPage();
    const response = await payer.goto(href, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(payer.locator("body")).toContainText(invoiceNumber, { timeout: 45_000 });
    await expect(payer.locator("body")).toContainText(amount);
    await payer.close();

    // cancel needs a second, confirming press
    await note(page, orderId).getByRole("button", { name: OPEN_CANCEL }).click();
    expect((await orderRow(orderId)).status).toBe("sent"); // opening the question changes nothing
    await expect(note(page, orderId).getByRole("button", { name: "Keep the invoice" })).toBeVisible();
    await note(page, orderId).getByRole("button", { name: CONFIRM_CANCEL }).click();
    await expect(note(page, orderId).getByRole("status")).toContainText("Cancelled", { timeout: 40_000 });
    expect((await paypal("GET", `/v2/invoicing/invoices/${sent.paypal_invoice_id}`)).json.status).toBe("CANCELLED");

    // quote again: same finding, a new draft, nothing sent
    await note(page, orderId).getByRole("button", { name: REQUOTE }).click();
    await expect.poll(async () => (await rows("SELECT id FROM change_orders WHERE finding_id = ? AND status = 'draft'", [before.finding_id])).length, { timeout: 15_000 }).toBe(1);
    const [again] = await rows<{ id: string; title: string; amount_cents: number; paypal_invoice_id: string | null }>("SELECT id, title, amount_cents, paypal_invoice_id FROM change_orders WHERE finding_id = ? AND status = 'draft'", [before.finding_id]);
    expect(again.id).not.toBe(orderId);
    expect(again.title).toBe(before.title);
    expect(again.amount_cents).toBe(before.amount_cents);
    expect(again.paypal_invoice_id).toBeNull();
    await expect(page.locator(`aside[data-change-order-id="${again.id}"]`).getByRole("button", { name: SEND })).toBeVisible();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `test-results/screens/p2-requoted.png`, fullPage: true });

    // (g) the steps in order, times not going backwards
    const events = await rows<{ kind: string; at: string }>("SELECT kind, at FROM activity_events WHERE change_order_id = ? ORDER BY id", [orderId]);
    expect(events.map((e) => e.kind)).toEqual(["invoice_created", "invoice_sent", "invoice_cancelled"]);
    expect(events.map((e) => e.at)).toEqual(events.map((e) => e.at).sort());
    info.annotations.push({ type: "invoice", description: String(sent.paypal_invoice_id) });
    await context.close();
  });

  test("P2 (b) 같은 컨텍스트의 두 탭이 동시에 발송을 눌러도 PayPal 검색에서 그 청구서 번호는 1건이다", async ({ browser }) => {
    const { context, page } = await open(browser);
    const second = await context.newPage();
    await second.goto("/");
    await expect(second.getByTestId("workspace")).toBeVisible();
    const orderId = (await idOf(page))!;
    const send = (p: Page) => note(p, orderId).getByRole("button", { name: SEND });
    await expect(send(second)).toBeVisible();

    await Promise.all([send(page).click(), send(second).click()]);

    await expect.poll(async () => (await orderRow(orderId)).status, { timeout: 40_000 }).toBe("sent");
    const row = await orderRow(orderId);
    remember(row.paypal_invoice_id);
    const number: string = (await paypal("GET", `/v2/invoicing/invoices/${row.paypal_invoice_id}`)).json.detail.invoice_number;
    let found: Array<{ id: string; detail: { invoice_number: string } }> = [];
    for (let i = 0; i < 8; i++) {
      found = ((await paypal("POST", "/v2/invoicing/search-invoices", { invoice_number: number })).json.items ?? []).filter((x: { detail: { invoice_number: string } }) => x.detail.invoice_number === number);
      if (found.length) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    found.forEach((f) => remember(f.id));
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(row.paypal_invoice_id);
    const sentEvents = await rows("SELECT id FROM activity_events WHERE change_order_id = ? AND kind = 'invoice_sent'", [orderId]);
    expect(sentEvents).toHaveLength(1);
    await context.close();
  });
});
