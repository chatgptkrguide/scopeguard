import { expect, test } from "@playwright/test";

test("첫 화면이 열리고 제품 이름이 보인다", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Tollgate", { exact: true })).toBeVisible();
});
