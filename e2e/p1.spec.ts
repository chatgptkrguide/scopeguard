import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const SHOTS = process.env.E2E_SHOTS_DIR ?? "test-results/screens"; // inside the repo, git-ignored
const WAIVE = "Include at no charge";
const CONFIRM = "Confirm: include at no charge";
const KEEP = "Keep the charge";
const FORGED = /isn.t your demo copy|isn.t in your demo copy/;

const include = (page: Page) => page.getByRole("button", { name: WAIVE, exact: true });
const confirmButton = (page: Page) => page.getByRole("button", { name: CONFIRM, exact: true });
// Waiving asks once more (D-015): first press opens the confirmation, the second one commits.
async function waive(page: Page) {
  await include(page).first().click();
  await confirmButton(page).click();
}

const projectId = (page: Page) => page.getByTestId("workspace").getAttribute("data-project-id");
const totalText = (page: Page) => page.locator("dl.mt-5 div").last().locator("dd").innerText();
const orderIds = (page: Page) => page.locator("aside[data-change-order-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-change-order-id")!));

async function open(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("workspace")).toBeVisible();
  return { context, page };
}

test.describe("P1 인수 시험", () => {
  test("P1 (a) 새 브라우저 컨텍스트 둘은 서로 다른 프로젝트 id의 사본을 받는다", async ({ browser }) => {
    const a = await open(browser);
    const b = await open(browser);

    const [idA, idB] = [await projectId(a.page), await projectId(b.page)];

    expect(idA).toMatch(/^v_/);
    expect(idB).toMatch(/^v_/);
    expect(idA).not.toBe(idB);
    await a.context.close();
    await b.context.close();
  });

  test("P1 (a) 같은 컨텍스트로 다시 열면 같은 프로젝트 id다", async ({ browser }) => {
    const a = await open(browser);
    const first = await projectId(a.page);

    await a.page.goto("/");

    expect(await projectId(a.page)).toBe(first);
    await a.context.close();
  });

  test("P1 (a) 방문자 쿠키는 HttpOnly이고 SameSite=Lax다", async ({ browser }) => {
    const a = await open(browser);

    const cookie = (await a.context.cookies()).find((c) => c.name === "tg_visitor");

    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    await a.context.close();
  });

  test("P1 (a) 쿠키를 지우고 다시 오면 새 사본을 받는다", async ({ browser }) => {
    const a = await open(browser);
    const before = await projectId(a.page);

    await a.context.clearCookies();
    await a.page.goto("/");

    await expect(a.page.getByTestId("workspace")).toBeVisible();
    const after = await projectId(a.page);
    expect(after).toMatch(/^v_/);
    expect(after).not.toBe(before);
    expect(await totalText(a.page)).toBe("$3,300");
    await a.context.close();
  });

  test("P1 (b) 무료 처리 뒤 새로고침해도 상태와 합계가 유지된다", async ({ browser }) => {
    const { context, page } = await open(browser);
    expect(await totalText(page)).toBe("$3,300");

    await waive(page);
    await expect(page.getByText("Included at no charge").first()).toBeVisible();
    const afterClick = await totalText(page);
    await page.reload();

    await expect(page.getByText("Included at no charge").first()).toBeVisible();
    expect(await totalText(page)).toBe(afterClick);
    expect(afterClick).not.toBe("$3,300");
    await context.close();
  });

  test("P1 (b) 무료 처리 단추를 빠르게 두 번 눌러도 한 번만 처리되고 오류가 없다", async ({ browser }) => {
    const { context, page } = await open(browser);
    await include(page).first().click();

    await confirmButton(page).dblclick();
    await expect(page.getByText("Included at no charge").first()).toBeVisible();
    await page.reload();

    await expect(page.getByText("Included at no charge")).toHaveCount(2); // 메모 1 + 합계 패널 1
    await expect(page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(0);
    await expect(page.getByText(/already updated|Something went wrong/)).toHaveCount(0);
    await context.close();
  });

  test("P1 (b) 확인 단계에서 Keep the charge를 누르면 아무것도 바뀌지 않는다", async ({ browser }) => {
    const { context, page } = await open(browser);
    await include(page).first().click();
    await expect(confirmButton(page)).toBeVisible();

    await page.getByRole("button", { name: KEEP, exact: true }).click();

    await expect(confirmButton(page)).toHaveCount(0);
    await expect(include(page)).toHaveCount(1);
    await expect(include(page).first()).toBeFocused();
    expect(await totalText(page)).toBe("$3,300");
    await page.reload();
    await expect(include(page)).toHaveCount(1);
    expect(await totalText(page)).toBe("$3,300");
    await expect(page.getByText("Included at no charge")).toHaveCount(0);
    await context.close();
  });

  test("P1 (b) 무료 처리에 성공하면 초점이 상태 줄(role=status)로 간다", async ({ browser }) => {
    const { context, page } = await open(browser);

    await waive(page);

    const status = page.locator("aside[data-status='waived'] [role='status']");
    await expect(status).toContainText("Included at no charge");
    await expect(status).toBeFocused();
    await context.close();
  });

  test("P1 (a) 유효 쿠키로 다시 오면 응답이 같은 쿠키를 다시 설정해 연장한다", async ({ browser }) => {
    const { context, page } = await open(browser);
    const id = await projectId(page);
    const cookie = (await context.cookies()).find((c) => c.name === "tg_visitor")!;

    const response = await page.goto("/");

    const setCookie = (await response!.allHeaders())["set-cookie"] ?? "";
    expect(setCookie).toContain(`tg_visitor=${cookie.value}`);
    expect(setCookie).toMatch(/max-age=604800|expires=/i);
    expect(await projectId(page)).toBe(id);
    await context.close();
  });

  test("P1 (c) 재설정하면 견적 상태와 합계 $3,300이 처음 시드와 같아진다", async ({ browser }) => {
    const { context, page } = await open(browser);
    const seedIds = await orderIds(page);
    const seedAgreed = await page.locator("dl.mt-5 div").first().locator("dd").innerText();
    await waive(page);
    await expect(page.getByText("Included at no charge").first()).toBeVisible();

    await page.getByRole("button", { name: "Reset demo" }).click();
    await page.getByRole("button", { name: "Confirm: reset demo" }).click();

    await expect(page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(1);
    expect(await totalText(page)).toBe("$3,300");
    expect(seedAgreed).toBe("$2,400");
    expect(await page.locator("aside[data-status='draft']").count()).toBe(1);
    expect((await orderIds(page)).length).toBe(seedIds.length);
    await context.close();
  });

  test("P1 (c) 재설정을 두 번 연속 눌러도 시드 상태와 같고 프로젝트 id는 그대로다", async ({ browser }) => {
    const { context, page } = await open(browser);
    const id = await projectId(page);
    await waive(page);
    await expect(page.getByText("Included at no charge").first()).toBeVisible();

    const reset = page.getByRole("button", { name: "Reset demo" });
    const confirm = page.getByRole("button", { name: "Confirm: reset demo" });
    await reset.click();
    await confirm.click();
    await expect(page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(1);
    await reset.click();
    await confirm.click();
    await page.waitForTimeout(500);
    await page.reload();

    await expect(page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(1);
    expect(await totalText(page)).toBe("$3,300");
    expect(await projectId(page)).toBe(id);
    await context.close();
  });

  test("P1 (c) 재설정은 확인을 거치고, 'Keep my changes'를 누르면 아무것도 바뀌지 않는다", async ({ browser }) => {
    const { context, page } = await open(browser);
    await waive(page);
    await expect(page.getByText("Included at no charge").first()).toBeVisible();

    await page.getByRole("button", { name: "Reset demo" }).click();
    await expect(page.getByText("This deletes every change you made to this demo")).toBeVisible();
    await page.getByRole("button", { name: "Keep my changes" }).click();

    await expect(page.getByRole("button", { name: "Reset demo" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Confirm: reset demo" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Included at no charge").first()).toBeVisible();
    await context.close();
  });

  test("P1 (d) 다른 사본의 견적 id로 보낸 무료 처리는 거부되고 그 사본은 그대로다", async ({ browser }) => {
    const a = await open(browser);
    const b = await open(browser);
    const aOrderId = (await a.page.locator("aside[data-status='draft']").getAttribute("data-change-order-id")) ?? "";
    await include(b.page).first().click(); // React rewrites the hidden value on re-render, so forge after this
    await b.page.locator("form[data-action='waive'] input[name='changeOrderId']").first().evaluate((el, id) => ((el as HTMLInputElement).value = id), aOrderId);

    await confirmButton(b.page).click();

    await expect(b.page.getByText(FORGED)).toBeVisible();
    await a.page.reload();
    await expect(a.page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(1);
    expect(await totalText(a.page)).toBe("$3,300");
    await b.page.reload();
    await expect(b.page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(1);
    await a.context.close();
    await b.context.close();
  });

  test("P1 (d) 다른 사본의 프로젝트 id로 보낸 재설정은 거부되고 그 사본은 그대로다", async ({ browser }) => {
    const a = await open(browser);
    const b = await open(browser);
    await waive(a.page);
    await expect(a.page.getByText("Included at no charge").first()).toBeVisible();
    const aProject = await projectId(a.page);
    await b.page.getByRole("button", { name: "Reset demo" }).click(); // forge after this click: React rewrites the value on re-render
    await b.page.locator("form[data-action='reset-demo'] input[name='projectId']").evaluate((el, id) => ((el as HTMLInputElement).value = id!), aProject);

    await b.page.getByRole("button", { name: "Confirm: reset demo" }).click();

    await expect(b.page.getByText(FORGED)).toBeVisible();
    await a.page.reload();
    await expect(a.page.getByRole("button", { name: WAIVE, exact: true })).toHaveCount(0);
    await expect(a.page.getByText("Included at no charge").first()).toBeVisible();
    await a.context.close();
    await b.context.close();
  });

  test("P1 (d) 형식이 틀린 견적 id도 거부된다", async ({ browser }) => {
    const { context, page } = await open(browser);
    await include(page).first().click(); // forge after this click: React rewrites the value on re-render
    await page.locator("form[data-action='waive'] input[name='changeOrderId']").first().evaluate((el) => ((el as HTMLInputElement).value = "not-a-uuid"));

    await confirmButton(page).click();

    await expect(page.getByText(FORGED)).toBeVisible();
    expect(await totalText(page)).toBe("$3,300");
    await context.close();
  });

  test("P1 2.1.5 발송 버튼은 비활성이고 이유 문구가 보인다", async ({ browser }) => {
    const { context, page } = await open(browser);
    const send = page.getByRole("button", { name: "Send change order" }).first();

    await expect(send).toHaveAttribute("aria-disabled", "true");
    const reasonId = await send.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${reasonId}"]`)).toBeVisible();
    await expect(page.locator(`[id="${reasonId}"]`)).toContainText("PayPal");
    await context.close();
  });

  for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    test(`P1 (f) ${name} ${width}px에서 여백 메모와 버튼이 모두 보이고 표시 밑줄이 끊기지 않는다`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height } }); // 애니메이션 켠 채로
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByTestId("workspace")).toBeVisible();
      await page.waitForTimeout(1000); // 표시 그리기 520ms + 메모 등장 420+260ms

      const notes = page.locator("aside.margin-note");
      await expect(notes).toHaveCount(2);
      const targets = [
        ...(await notes.all()),
        ...(await page.getByRole("button", { name: "Send change order" }).all()),
        ...(await page.getByRole("button", { name: WAIVE, exact: true }).all()),
        page.getByRole("button", { name: "Reset demo" }),
      ];
      expect(targets.length).toBe(5);
      for (const t of targets) {
        await expect(t).toBeVisible();
        const box = (await t.boundingBox())!;
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      }
      // 메모는 등장 애니메이션이 끝나 완전히 불투명하다(발송 버튼은 설계상 흐리게 비활성이라 제외)
      for (const n of await notes.all()) expect(await n.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      // 가로 스크롤이 없다
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      const marks = page.locator("mark.scope-mark");
      expect(await marks.count()).toBe(2);
      for (const m of await marks.all()) {
        const style = await m.evaluate((el) => {
          const s = getComputedStyle(el);
          return { size: s.backgroundSize, image: s.backgroundImage, clone: s.boxDecorationBreak, rects: Array.from(el.getClientRects()).map((r) => r.width) };
        });
        expect(style.size).toBe("100% 2px, 100% 100%"); // 그리기 끝난 뒤 밑줄이 전체 너비
        expect(style.image).toContain("linear-gradient");
        expect(style.clone).toBe("clone"); // 줄이 바뀌어도 줄마다 밑줄이 이어진다
        for (const w of style.rects) expect(w).toBeGreaterThan(0);
      }

      await page.screenshot({ path: `${SHOTS}/screen-${name}.png`, fullPage: true });
      await context.close();
    });
  }
});
